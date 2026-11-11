import {
  KERNEL_SCOPE_ID,
  projectScopeId,
  shapeSubscribeFrameSchema,
  type ShapeDeltaFrame,
  type ShapeSubscribeFrame,
  type StreamDeltaFrame,
} from "@inhuman.tools/harness-contract/schema";
import { DocumentContainer, type PresenceEntry, type ReactiveAwareness } from "@inhuman.tools/model";

import { encodeLocalAwarenessFrame, REMOTE_AWARENESS_ORIGIN } from "./awareness.js";
import {
  applyNodeShapeDelta,
  decodePlaneFrame,
  encodePlaneFrame,
  encodePresenceQuery,
  encodePresenceUpdate,
  encodeShapeSubscribe,
  encodeShapeUnsubscribe,
} from "./frames.js";

export type RoomConnectionOptions = {
  readonly connect?: boolean;
  readonly WebSocketPolyfill?: typeof WebSocket;
  readonly params?: Record<string, string>;
  readonly awareness?: ReactiveAwareness<any>;
  readonly shouldReconnect?: (event: CloseEvent) => boolean;
  readonly maxBackoffTime?: number;
};

const WS_OPEN = 1;
const ROOM_NODES_SUBSCRIPTION_ID = "room:nodes";
const textDecoder = new TextDecoder();

type ActiveClientLaneSub = {
  frame: ShapeSubscribeFrame;
  offset: number;
  listeners: Set<(delta: ShapeDeltaFrame) => void>;
};

function defaultNodeLaneFrame(roomname: string, params: Record<string, string>, offset?: number): ShapeSubscribeFrame | null {
  if (roomname === "kernel") {
    return {
      kind: "shape/subscribe",
      subscriptionId: ROOM_NODES_SUBSCRIPTION_ID,
      lane: "scope_nodes",
      params: { scopeId: KERNEL_SCOPE_ID },
      ...(offset !== undefined && offset > 0 ? { offset } : {}),
    };
  }
  if (roomname === "project" && typeof params.path === "string" && params.path.length > 0) {
    return {
      kind: "shape/subscribe",
      subscriptionId: ROOM_NODES_SUBSCRIPTION_ID,
      lane: "scope_nodes",
      params: { scopeId: projectScopeId(params.path) },
      ...(offset !== undefined && offset > 0 ? { offset } : {}),
    };
  }
  if (roomname === "session" && typeof params.sessionId === "string" && params.sessionId.length > 0) {
    return {
      kind: "shape/subscribe",
      subscriptionId: ROOM_NODES_SUBSCRIPTION_ID,
      lane: "session_nodes",
      params: { sessionId: params.sessionId },
      ...(offset !== undefined && offset > 0 ? { offset } : {}),
    };
  }
  return null;
}

function decodeIncomingText(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (data instanceof Uint8Array) return textDecoder.decode(data);
  if (data instanceof ArrayBuffer) return textDecoder.decode(new Uint8Array(data));
  if (ArrayBuffer.isView(data)) {
    return textDecoder.decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }
  return null;
}

export class RoomConnection {
  readonly url: string;
  readonly roomname: string;
  readonly doc: DocumentContainer<any, any>;
  readonly awareness: ReactiveAwareness<any>;
  readonly options: RoomConnectionOptions;

  get params(): Record<string, string> {
    return this.options.params ?? {};
  }

  shouldConnect = true;
  ws: WebSocket | null = null;
  wsconnected = false;
  synced = false;
  wsLastMessageReceived = 0;

  readonly #listeners = new Map<string, Set<(...args: any[]) => void>>();
  readonly #laneSubscriptions = new Map<string, ActiveClientLaneSub>();
  #nodeLaneOffset = 0;
  #reconnectTimer?: ReturnType<typeof setTimeout>;
  #unsuccessfulReconnects = 0;
  #destroyed = false;
  readonly #awarenessUnsub: () => void;

  constructor(url: string, roomname: string, doc: DocumentContainer<any, any>, options: RoomConnectionOptions = {}) {
    this.url = url;
    this.roomname = roomname;
    this.doc = doc;
    this.options = options;
    this.shouldConnect = options.connect ?? true;
    this.awareness = options.awareness ?? doc.awareness;

    const onAwarenessUpdate = (
      changed: { added: number[]; updated: number[]; removed: number[] },
      origin?: unknown,
    ): void => {
      if (origin === this || origin === REMOTE_AWARENESS_ORIGIN) return;
      const clients = [...changed.added, ...changed.updated, ...changed.removed];
      if (clients.length === 0) return;
      const entries = this.awareness.toPresenceEntries(clients);
      if (entries.length === 0) return;
      this.sendText(encodePresenceUpdate(entries));
    };
    this.awareness.on("update", onAwarenessUpdate);
    this.#awarenessUnsub = () => this.awareness.off("update", onAwarenessUpdate);

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

  sendText(text: string): boolean {
    const ws = this.ws;
    if (ws != null && ws.readyState === WS_OPEN) {
      ws.send(text);
      return true;
    }
    return false;
  }

  subscribeLane(
    rawFrame: Omit<ShapeSubscribeFrame, "kind"> & { readonly kind?: "shape/subscribe" },
    onDelta?: (delta: ShapeDeltaFrame) => void,
  ): () => void {
    const frame = shapeSubscribeFrameSchema.parse({
      ...rawFrame,
      kind: "shape/subscribe",
    });
    let sub = this.#laneSubscriptions.get(frame.subscriptionId);
    if (!sub) {
      sub = {
        frame,
        offset: frame.offset ?? 0,
        listeners: new Set(),
      };
      this.#laneSubscriptions.set(frame.subscriptionId, sub);
      this.sendText(encodeShapeSubscribe(frame));
    }
    if (onDelta) {
      sub.listeners.add(onDelta);
    }
    return () => {
      const current = this.#laneSubscriptions.get(frame.subscriptionId);
      if (!current) return;
      if (onDelta) {
        current.listeners.delete(onDelta);
      }
      if (current.listeners.size === 0) {
        this.#laneSubscriptions.delete(frame.subscriptionId);
        this.sendText(encodeShapeUnsubscribe(frame.subscriptionId));
      }
    };
  }

  connect(): void {
    this.shouldConnect = true;
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
    this.ws = ws;

    this.emit("status", { status: "connecting" });

    ws.addEventListener("open", (): void => {
      if (this.ws !== ws) return;
      this.#unsuccessfulReconnects = 0;
      this.wsconnected = true;
      this.emit("status", { status: "connected" });

      const nodeFrame = defaultNodeLaneFrame(this.roomname, this.params, this.#nodeLaneOffset);
      if (nodeFrame != null) {
        ws.send(encodeShapeSubscribe(nodeFrame));
      }
      for (const sub of this.#laneSubscriptions.values()) {
        const resumeFrame: ShapeSubscribeFrame =
          sub.offset > 0 ? { ...sub.frame, offset: sub.offset } : sub.frame;
        ws.send(encodeShapeSubscribe(resumeFrame));
      }

      ws.send(encodePresenceQuery());
      const localPresence = encodeLocalAwarenessFrame(this.awareness);
      if (localPresence != null) {
        ws.send(localPresence);
      }
    });

    ws.addEventListener("message", (event: MessageEvent): void => {
      if (this.ws !== ws) return;
      this.wsLastMessageReceived = Date.now();
      const text = decodeIncomingText(event.data);
      if (text === null) return;
      if (text === " pong") return;

      this.emit("text", text);

      const frame = decodePlaneFrame(text);
      if (frame === null) return;

      switch (frame.kind) {
        case "shape/delta": {
          if (frame.subscriptionId === ROOM_NODES_SUBSCRIPTION_ID) {
            this.#nodeLaneOffset = frame.offset;
            applyNodeShapeDelta(this.doc, frame);
            if (!this.synced) {
              this.synced = true;
              this.emit("sync", true);
            }
          } else {
            const sub = this.#laneSubscriptions.get(frame.subscriptionId);
            if (sub) {
              sub.offset = frame.offset;
              for (const listener of sub.listeners) {
                listener(frame);
              }
            }
          }
          this.emit("shape", frame);
          break;
        }
        case "presence/state":
        case "presence/update": {
          this.awareness.applyPresenceEntries(frame.entries as readonly PresenceEntry[], REMOTE_AWARENESS_ORIGIN);
          this.emit("presence", frame);
          break;
        }
        case "presence/query": {
          const localPresence = encodeLocalAwarenessFrame(this.awareness);
          if (localPresence != null && ws.readyState === WS_OPEN) {
            ws.send(localPresence);
          }
          this.emit("presence", frame);
          break;
        }
        case "stream/delta": {
          this.emit("stream", frame satisfies StreamDeltaFrame);
          break;
        }
        case "ping": {
          if (ws.readyState === WS_OPEN) {
            ws.send(encodePlaneFrame({ kind: "pong", ts: frame.ts }));
          }
          break;
        }
        case "pong":
        case "shape/subscribe":
        case "shape/unsubscribe": {
          break;
        }
      }
      this.emit("message", frame);
    });

    ws.onerror = (error: Event): void => {
      if (this.ws !== ws) return;
      this.emit("connection-error", error);
    };

    ws.addEventListener("close", (event: CloseEvent): void => {
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
    });
  }

  disconnect(): void {
    this.shouldConnect = false;
    if (this.#reconnectTimer !== undefined) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = undefined;
    }
    if (this.ws != null) {
      this.ws.close();
      this.ws = null;
      this.wsconnected = false;
      this.synced = false;
      this.emit("status", { status: "disconnected" });
    }
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.disconnect();
    this.emit("closed", { reason: "destroyed" });
    this.#awarenessUnsub();
    this.#laneSubscriptions.clear();
    this.#listeners.clear();
  }
}
