/**
 * `WebSocket`-shaped wrapper that applies transparent chunking.
 *
 * One class, two constructor modes:
 *
 *   1. **Browser-style** — `new ChunkedWebSocket(url, protocols)` opens a
 *      fresh native `WebSocket` and wraps it. Drop-in replacement for the
 *      native constructor; works as `y-websocket`'s `WebSocketPolyfill`,
 *      anywhere a `WebSocket` constructor is expected.
 *
 *   2. **Server-side wrap** — `new ChunkedWebSocket(rawWs)` wraps an
 *      existing WebSocket (typically a workerd Durable Object's
 *      server-side socket from `acceptWebSocket(...)`, or a `ws` library
 *      socket on Node). The wrapper does NOT take ownership of the raw
 *      socket's lifecycle — the host (DO, server) keeps managing
 *      `acceptWebSocket` / `close` / hibernation; the wrapper is just the
 *      framing adapter.
 *
 * Inbound:
 *   - In browser-mode the wrapper subscribes to the native
 *     `WebSocket.onmessage` and runs every frame through `handleChunked`.
 *   - In server-wrap mode, the host has to feed raw frames in by
 *     calling `feed(rawMessage)` (because workerd's hibernation API is
 *     callback-shaped, not EventTarget-shaped — there's no `onmessage`
 *     to subscribe to from outside the DO). After feeding, the wrapper
 *     emits `'message'` events on its own EventTarget surface when a
 *     full application message has been reassembled.
 *
 * Outbound: both modes use `sendChunked` — anything above `CHUNK_MAX_SIZE`
 * bytes (strings included) splits into start-marker / N×binary / end-marker
 * frames.
 *
 * Surface implemented (matches the WebSocket members consumers actually
 * touch — y-websocket, plain `ws.send` / `ws.onmessage` users, etc.):
 *   - constructor(url, protocols?)        — browser mode
 *   - constructor(existingWebSocket)      — server-wrap mode
 *   - readyState, binaryType, url, protocol, bufferedAmount
 *   - OPEN/CLOSED/CONNECTING/CLOSING constants
 *   - onopen, onclose, onerror, onmessage setters (implemented over the EventTarget)
 *   - addEventListener / removeEventListener (typed via ChunkedWebSocketEventMap)
 *   - send(data)
 *   - close(code?, reason?)
 *   - feed(rawMessage)                    — server-wrap mode only
 *
 * For typed listeners (recommended):
 *   import { ChunkedWebSocket, type ChunkedWebSocketEventMap } from "...";
 *   ws.addEventListener("message", (e) => { e.data satisfies ArrayBuffer | string; });
 *
 * The on* setters are still supported for compatibility (e.g. y-websocket polyfill usage)
 * but are now backed by the same addEventListener / dispatch mechanism.
 */

import { handleChunked, RESET_SENTINEL, sendChunked, type ChunkedReceiveHandler } from "./protocol.js";

/**
 * Event map for ChunkedWebSocket. Use with addEventListener for full type safety.
 *
 * - "open"   — connection established (browser mode)
 * - "close"  — connection closed (may be CloseEvent or plain Event in Node)
 * - "error"  — error occurred
 * - "message" — application message: ArrayBuffer for binary, string for text
 */
export interface ChunkedWebSocketEventMap {
  open: Event;
  close: CloseEvent | Event;
  error: Event;
  message: MessageEvent<ArrayBuffer | string>;
}

/**
 * The parts of `WebSocket` we actually read or call on the wrapped socket.
 *
 * Using `Pick<WebSocket, ...>` keeps the declaration honest (only what
 * we depend on) and gives us the canonical DOM shape for cross-env
 * compatibility (browser WebSocket, workerd, Node `ws`, etc. are
 * structurally compatible with this subset).
 */
export type RawWebSocketLike = Pick<WebSocket, "readyState" | "send" | "close"> & {
  binaryType?: string;
  readonly url?: string;
  readonly protocol?: string;
  readonly bufferedAmount?: number;
};

/**
 * Second constructor argument. Besides the standard subprotocols, Node's
 * global `WebSocket` (undici) accepts an init object, which is the only
 * way to send request headers such as `Authorization`. Browsers do not.
 */
export type ChunkedWebSocketProtocols =
  string | string[] | { protocols?: string | string[]; headers?: Record<string, string> };

export class ChunkedWebSocket extends EventTarget {
  // WebSocket protocol-spec readyState constants.
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  addEventListener<K extends keyof ChunkedWebSocketEventMap>(
    type: K,
    listener: (this: ChunkedWebSocket, ev: ChunkedWebSocketEventMap[K]) => unknown,
    options?: boolean | AddEventListenerOptions,
  ): void;
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ): void {
    super.addEventListener(type, listener as EventListener, options);
  }

  removeEventListener<K extends keyof ChunkedWebSocketEventMap>(
    type: K,
    listener: (this: ChunkedWebSocket, ev: ChunkedWebSocketEventMap[K]) => unknown,
    options?: boolean | EventListenerOptions,
  ): void;
  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
  ): void {
    super.removeEventListener(type, listener as EventListener, options);
  }

  private readonly inner: RawWebSocketLike;

  // on* properties are implemented as getters/setters that register
  // listeners via the typed EventTarget. This unifies the codepath:
  // everything is driven by dispatchEvent + addEventListener.
  // Consumers can use either `ws.onmessage = ...` or `addEventListener('message', ...)`.
  private _onopen: ((this: ChunkedWebSocket, ev: Event) => unknown) | null = null;
  private _onclose: ((this: ChunkedWebSocket, ev: CloseEvent | Event) => unknown) | null = null;
  private _onerror: ((this: ChunkedWebSocket, ev: Event) => unknown) | null = null;
  private _onmessage: ((this: ChunkedWebSocket, ev: MessageEvent<ArrayBuffer | string>) => unknown) | null = null;

  get onopen(): ((this: ChunkedWebSocket, ev: Event) => unknown) | null {
    return this._onopen;
  }
  set onopen(handler) {
    if (this._onopen) {
      this.removeEventListener("open", this._onopen as any);
    }
    this._onopen = handler;
    if (handler) {
      this.addEventListener("open", handler as any);
    }
  }

  get onclose(): ((this: ChunkedWebSocket, ev: CloseEvent | Event) => unknown) | null {
    return this._onclose;
  }
  set onclose(handler) {
    if (this._onclose) {
      this.removeEventListener("close", this._onclose as any);
    }
    this._onclose = handler;
    if (handler) {
      this.addEventListener("close", handler as any);
    }
  }

  get onerror(): ((this: ChunkedWebSocket, ev: Event) => unknown) | null {
    return this._onerror;
  }
  set onerror(handler) {
    if (this._onerror) {
      this.removeEventListener("error", this._onerror as any);
    }
    this._onerror = handler;
    if (handler) {
      this.addEventListener("error", handler as any);
    }
  }

  get onmessage(): ((this: ChunkedWebSocket, ev: MessageEvent<ArrayBuffer | string>) => unknown) | null {
    return this._onmessage;
  }
  set onmessage(handler) {
    if (this._onmessage) {
      this.removeEventListener("message", this._onmessage as any);
    }
    this._onmessage = handler;
    if (handler) {
      this.addEventListener("message", handler as any);
    }
  }

  private readonly chunkHandler: ChunkedReceiveHandler;

  constructor(urlOrWebSocket: string | RawWebSocketLike, protocols?: ChunkedWebSocketProtocols) {
    super();

    if (typeof urlOrWebSocket === "string") {
      // Browser mode — open a fresh native WebSocket.
      this.inner = new WebSocket(urlOrWebSocket, protocols as string | string[] | undefined);
      // y-websocket relies on `event.data` being an `ArrayBuffer` for
      // binary frames; native default is "blob", so flip it eagerly.
      this.inner.binaryType = "arraybuffer";
    } else {
      // Server-wrap mode — adopt an existing WebSocket. No subscription
      // setup; the host calls `feed(...)` for every inbound frame.
      this.inner = urlOrWebSocket;
    }

    this.chunkHandler = handleChunked((data) => {
      this.dispatchEvent(new MessageEvent("message", { data }));
    });

    // Browser-mode wiring: subscribe to native events and forward them.
    // In server-wrap mode `inner.onmessage` is read-only or absent; the
    // host feeds frames via `feed(...)` instead.
    if (typeof urlOrWebSocket === "string") {
      const native = this.inner as WebSocket;
      native.onmessage = (ev) => this.chunkHandler({ data: ev.data as ArrayBuffer | string });
      native.addEventListener("open", () => {
        this.dispatchEvent(new Event("open"));
      });
      native.addEventListener("close", (ev) => {
        // Node 22 has no global `CloseEvent`; a bare `Event` would drop the code and reason
        // (the relay's 4503 / 4504 live there), so carry them on the fallback.
        const Ctor = globalThis.CloseEvent;
        const closeEv = Ctor
          ? new Ctor("close", ev)
          : Object.assign(new Event("close"), { code: ev.code, reason: ev.reason, wasClean: ev.wasClean });
        this.dispatchEvent(closeEv);
      });
      native.onerror = () => {
        this.dispatchEvent(new Event("error"));
      };
    }
  }

  /**
   * Server-wrap mode only. The host (workerd DO, Node `ws` server, …)
   * calls this with every raw inbound frame. After reassembly the
   * wrapper fires a `'message'` event whose `data` is the joined
   * `ArrayBuffer` or string (or the original frame untouched if it was
   * unchunked).
   *
   * In browser mode `feed` is unused — the wrapper subscribes to
   * native `onmessage` itself. Calling `feed` in that mode is a no-op
   * with the right semantics (just a duplicate dispatch path; harmless
   * if you do, redundant if you don't).
   */
  feed(rawMessage: ArrayBufferLike | string): void {
    this.chunkHandler({ data: rawMessage });
  }

  /**
   * Drop any in-flight batch state and enter DRAIN mode — subsequent
   * binary frames are silently discarded until the next `start` marker
   * arrives. Use when the wrapper's view of the conversation has gone
   * stale (e.g. server post-hibernation: it has no idea whether the
   * peer is mid-upload, so it discards anything not bracketed by fresh
   * markers).
   *
   * Does not notify the peer. Pair with `dispatchReset()` if the peer
   * should also drop its state.
   */
  beginDrain(): void {
    this.chunkHandler.reset();
  }

  /**
   * Send a reset marker to the peer. The peer's chunked-receive handler
   * will drop any in-flight batch state and enter DRAIN itself. Used by
   * the server when it observes a WebSocket it has no in-memory state
   * for (fresh accept OR post-hibernation wake) to invalidate whatever
   * batch the client may have been mid-receiving.
   *
   * Idempotent and cheap (one ~10-byte text frame). Does not change
   * the local handler's state — call `beginDrain()` separately if you
   * also need to drop local state.
   */
  dispatchReset(): void {
    this.inner.send(RESET_SENTINEL);
  }

  get readyState(): number {
    return this.inner.readyState;
  }

  get binaryType(): BinaryType {
    return (this.inner.binaryType as BinaryType | undefined) ?? "arraybuffer";
  }
  set binaryType(value: BinaryType) {
    this.inner.binaryType = value;
  }

  get url(): string {
    return this.inner.url ?? "";
  }

  get protocol(): string {
    return this.inner.protocol ?? "";
  }

  get bufferedAmount(): number {
    return this.inner.bufferedAmount ?? 0;
  }

  send(data: ArrayBufferLike | ArrayBufferView | string): void {
    if (typeof data === "string") {
      sendChunked(data, this.inner);
      return;
    }
    if (ArrayBuffer.isView(data)) {
      // y-websocket sends `Uint8Array` from `encoding.toUint8Array(...)`.
      // Use the underlying buffer slice so chunking sees a flat
      // ArrayBuffer of the right byte range.
      sendChunked(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), this.inner);
      return;
    }
    sendChunked(data, this.inner);
  }

  close(code?: number, reason?: string): void {
    this.inner.close(code, reason);
  }
}
