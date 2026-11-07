import {
  applyAwarenessUpdate,
  DocumentContainer,
  encodeAwarenessUpdate,
  type ReactiveAwareness,
} from "@inhuman.tools/model";

import { encodeLocalAwarenessFrame } from "./awareness.js";
import {
  applyPeerSyncFrame,
  decodeAwarenessPayload,
  encodeAwarenessFrame,
  encodeDocUpdate,
  encodeQueryAwareness,
  encodeSyncStep1,
  MESSAGE_AWARENESS,
  MESSAGE_QUERY_AWARENESS,
  MESSAGE_SHAPE,
  MESSAGE_SYNC,
  peekMessageType,
  SYNC_STEP2,
} from "./frames.js";

export type WebsocketProviderOptions = {
  readonly connect?: boolean;
  readonly WebSocketPolyfill?: typeof WebSocket;
  readonly params?: Record<string, string>;
  readonly resyncInterval?: number;
  readonly awareness?: ReactiveAwareness<any>;
  readonly shouldReconnect?: (event: CloseEvent) => boolean;
  readonly maxBackoffTime?: number;
  readonly disableBc?: boolean;
};

const WS_OPEN = 1;

export class WebsocketProvider {
  readonly url: string;
  readonly roomname: string;
  readonly doc: DocumentContainer<any, any>;
  readonly awareness: ReactiveAwareness<any>;
  readonly options: WebsocketProviderOptions;

  get params(): Record<string, string> {
    return this.options.params ?? {};
  }

  shouldConnect = true;

  ws: WebSocket | null = null;
  wsconnected = false;
  synced = false;
  wsLastMessageReceived = 0;

  readonly messageHandlers: Record<number, (...args: any[]) => void> = {};

  readonly #listeners = new Map<string, Set<(...args: any[]) => void>>();
  #resyncTimer?: ReturnType<typeof setInterval>;
  #reconnectTimer?: ReturnType<typeof setTimeout>;
  #unsuccessfulReconnects = 0;
  #destroyed = false;
  readonly #docUnsub: () => void;
  readonly #awarenessUnsub: () => void;

  constructor(
    url: string,
    roomname: string,
    doc: DocumentContainer<any, any>,
    options: WebsocketProviderOptions = {},
  ) {
    this.url = url;
    this.roomname = roomname;
    this.doc = doc;
    this.options = options;
    this.shouldConnect = options.connect ?? true;
    this.awareness = options.awareness ?? doc.awareness;

    const onDocUpdate = (update: Uint8Array, origin?: unknown): void => {
      if (origin === this) return;
      const ws = this.ws;
      if (ws != null && ws.readyState === WS_OPEN) {
        ws.send(encodeDocUpdate(update));
      }
    };
    this.doc.on("update", onDocUpdate);
    this.#docUnsub = () => this.doc.off("update", onDocUpdate);

    const onAwarenessUpdate = (
      changed: { added: number[]; updated: number[]; removed: number[] },
      origin?: unknown,
    ): void => {
      if (origin === this) return;
      const clients = [...changed.added, ...changed.updated, ...changed.removed];
      if (clients.length === 0) return;
      try {
        const update = encodeAwarenessUpdate(this.awareness, clients);
        const ws = this.ws;
        if (ws != null && ws.readyState === WS_OPEN) {
          ws.send(encodeAwarenessFrame(update));
        }
      } catch {
        // awareness not ready
      }
    };
    this.awareness.on("update", onAwarenessUpdate);
    this.#awarenessUnsub = () => this.awareness.off("update", onAwarenessUpdate);

    this.messageHandlers[MESSAGE_SYNC] = (_encoder: unknown, decoder: { arr: Uint8Array; pos: number }) => {
      const frameBytes = decoder.arr;
      const reply = applyPeerSyncFrame(frameBytes, this.doc, this);
      if (reply != null && this.ws != null && this.ws.readyState === WS_OPEN) {
        this.ws.send(reply);
      }
      if (frameBytes.length >= 2 && frameBytes[1] === SYNC_STEP2) {
        if (!this.synced) {
          this.synced = true;
          this.emit("sync", true);
        }
      }
    };

    if (options.connect !== false) {
      this.connect();
    }
  }

  on(event: string, fn: (...args: any[]) => void): void {
    let set = this.#listeners.get(event);
    if (set === undefined) {
      set = new Set();
      this.#listeners.set(event, set);
    }
    set.add(fn);
  }

  off(event: string, fn: (...args: any[]) => void): void {
    this.#listeners.get(event)?.delete(fn);
  }

  emit(event: string, ...args: unknown[]): void {
    const set = this.#listeners.get(event);
    if (set !== undefined) {
      for (const fn of set) {
        fn(...args);
      }
    }
  }

  connect(): void {
    if (this.ws != null) return;

    const WebSocketConstructor =
      this.options.WebSocketPolyfill ?? (typeof WebSocket !== "undefined" ? WebSocket : undefined);
    if (WebSocketConstructor === undefined) return;

    let fullUrl = this.url.endsWith("/") ? `${this.url}${this.roomname}` : `${this.url}/${this.roomname}`;
    if (this.options.params !== undefined && Object.keys(this.options.params).length > 0) {
      const search = new URLSearchParams(this.options.params).toString();
      if (search.length > 0) fullUrl += (fullUrl.includes("?") ? "&" : "?") + search;
    }

    const ws = new WebSocketConstructor(fullUrl);
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    this.emit("status", { status: "connecting" });

    ws.onopen = (): void => {
      if (this.ws !== ws) return;
      this.#unsuccessfulReconnects = 0;
      this.wsconnected = true;
      this.emit("status", { status: "connected" });
      ws.send(encodeSyncStep1(this.doc));
      ws.send(encodeQueryAwareness());
      const localAw = encodeLocalAwarenessFrame(this.awareness);
      if (localAw != null) {
        ws.send(localAw);
      }
    };

    ws.onmessage = (event: MessageEvent): void => {
      if (this.ws !== ws) return;
      this.wsLastMessageReceived = Date.now();
      const data: unknown = event.data;
      if (typeof data === "string") return;

      let bytes: Uint8Array;
      if (data instanceof Uint8Array) {
        bytes = data;
      } else if (data instanceof ArrayBuffer) {
        bytes = new Uint8Array(data);
      } else if (ArrayBuffer.isView(data)) {
        bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      } else {
        return;
      }

      const type = peekMessageType(bytes);
      const customHandler = this.messageHandlers[type];
      if (customHandler != null) {
        customHandler(null, { arr: bytes, pos: 1 }, this);
      } else if (type === MESSAGE_SYNC) {
        const reply = applyPeerSyncFrame(bytes, this.doc, this);
        if (reply != null && ws.readyState === WS_OPEN) {
          ws.send(reply);
        }
        if (bytes.length >= 2 && bytes[1] === SYNC_STEP2) {
          if (!this.synced) {
            this.synced = true;
            this.emit("sync", true);
          }
        }
      } else if (type === MESSAGE_AWARENESS) {
        const payload = decodeAwarenessPayload(bytes);
        if (payload != null) {
          try {
            applyAwarenessUpdate(this.awareness, payload, this);
          } catch {
            // malformed awareness frame
          }
        }
      } else if (type === MESSAGE_QUERY_AWARENESS) {
        const localAw = encodeLocalAwarenessFrame(this.awareness);
        if (localAw != null && ws.readyState === WS_OPEN) {
          ws.send(localAw);
        }
      } else if (type === MESSAGE_SHAPE) {
        this.emit("shape", bytes);
      }
      this.emit("message", bytes);
    };

    ws.onerror = (error: Event): void => {
      if (this.ws !== ws) return;
      this.emit("connection-error", error);
    };

    ws.onclose = (event: CloseEvent): void => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.wsconnected = false;
      this.synced = false;
      this.emit("status", { status: "disconnected" });
      this.emit("connection-close", event);

      if (this.#destroyed) {
        this.shouldConnect = false;
        this.emit("closed", event);
        return;
      }

      const reconnectAllowed = this.options.shouldReconnect ? this.options.shouldReconnect(event) : true;
      if (this.shouldConnect && reconnectAllowed) {
        const maxBackoff = this.options.maxBackoffTime ?? 2500;
        const delay = Math.min(Math.pow(2, this.#unsuccessfulReconnects) * 100, maxBackoff);
        this.#unsuccessfulReconnects++;
        this.#reconnectTimer = setTimeout(() => {
          this.#reconnectTimer = undefined;
          this.connect();
        }, delay);
      } else {
        this.shouldConnect = false;
        this.emit("closed", event);
      }
    };

    if (this.options.resyncInterval != null && this.options.resyncInterval > 0) {
      this.#resyncTimer = setInterval(() => {
        if (this.ws != null && this.ws.readyState === WS_OPEN) {
          this.ws.send(encodeSyncStep1(this.doc));
        }
      }, this.options.resyncInterval);
    }
  }

  disconnect(): void {
    this.shouldConnect = false;
    if (this.#reconnectTimer !== undefined) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = undefined;
    }
    if (this.#resyncTimer !== undefined) {
      clearInterval(this.#resyncTimer);
      this.#resyncTimer = undefined;
    }
    if (this.ws != null) {
      this.ws.close();
      this.ws = null;
      this.wsconnected = false;
      this.synced = false;
      this.emit("status", { status: "disconnected" });
    }
  }

  disconnectBc(): void {}

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.disconnect();
    this.emit("closed", { reason: "destroyed" });
    this.#docUnsub();
    this.#awarenessUnsub();
    this.#listeners.clear();
  }
}
