/**
 * A client that behaves like the web app in remote mode (`harness-web-app/src/client/dial.ts`):
 * y-websocket over `ChunkedWebSocket`, relay text frames wrapped, a 10 s `" ping"`, JSON-RPC on the room.
 * Node's WebSocket takes a `Cookie` and an `Origin` header, which a real browser sets itself.
 */
import { ChunkedWebSocket } from "@inhuman.tools/chunked-websocket/client";
import {
  bindJsonRpc,
  bindTextFrames,
  destroyProvider,
  detachProtocolAwareness,
  waitForSync,
  type JsonRpcPort,
} from "@inhuman.tools/harness-peer";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";

import { DEV_SECRET } from "./stack.js";

export type Closed = { code: number; reason: string };

/** Relay refusals end the redial, as in the app. */
const isRefusal = (code: number): boolean => code === 4400 || code === 4404 || code === 4500;

export class Room {
  readonly closes: Closed[] = [];
  readonly statuses: string[] = [];
  readonly rpc: JsonRpcPort;
  readonly #ping: NodeJS.Timeout;

  constructor(
    readonly provider: WebsocketProvider,
    readonly doc: Y.Doc,
  ) {
    detachProtocolAwareness(provider);
    bindTextFrames(provider, () => undefined);
    this.rpc = bindJsonRpc(provider);
    provider.on("connection-close", (event: CloseEvent | null) => {
      if (event != null) this.closes.push({ code: event.code, reason: event.reason });
    });
    provider.on("status", (event: { status: string }) => this.statuses.push(event.status));
    this.#ping = setInterval(() => {
      if (provider.ws?.readyState === 1) provider.ws.send(" ping");
    }, 10_000);
  }

  synced(timeoutMs = 20_000): Promise<void> {
    return waitForSync(this.provider, "room", timeoutMs);
  }

  call(method: string, params?: unknown): Promise<any> {
    return this.rpc.request(method, params);
  }

  destroy(): void {
    clearInterval(this.#ping);
    this.rpc.rejectAll(new Error("room closed"));
    destroyProvider(this.provider);
    this.doc.destroy();
  }
}

export class Browser {
  readonly #rooms = new Set<Room>();

  private constructor(
    readonly base: string,
    readonly cookie: string,
  ) {}

  /** `GET /auth/login?dev_token=...` sets the `relay_dev` cookie; the browser would keep it in its jar. */
  static async login(base: string, who: { sub: string; email: string }, secret = DEV_SECRET): Promise<Browser> {
    const url = `${base}/auth/login?dev_token=${encodeURIComponent(secret)}&sub=${encodeURIComponent(who.sub)}&email=${encodeURIComponent(who.email)}`;
    const res = await fetch(url, { redirect: "manual" });
    const set = res.headers.getSetCookie().find((c) => c.startsWith("relay_dev="));
    if (res.status !== 303 || set === undefined) throw new Error(`dev login failed: ${res.status}`);
    return new Browser(base, set.split(";")[0]!);
  }

  fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("cookie", this.cookie);
    return fetch(`${this.base}${path}`, { redirect: "manual", ...init, headers });
  }

  async machines(): Promise<Array<{ machineId: string; name: string; online: boolean }>> {
    const res = await this.fetch("/api/machines");
    if (!res.ok) throw new Error(`/api/machines ${res.status}`);
    return (await res.json()) as Array<{ machineId: string; name: string; online: boolean }>;
  }

  /** The app's `new WebsocketProvider(roomOrigin, roomName, doc, { params, WebSocketPolyfill })`. */
  room(machineId: string, name: string, params: Record<string, string> = {}, guid?: string): Room {
    const origin = this.base.replace(/^http/, "ws");
    const cookie = this.cookie;
    const sameOrigin = this.base;
    class CookieSocket extends ChunkedWebSocket {
      constructor(url: string | URL) {
        super(String(url), { headers: { Cookie: cookie, Origin: sameOrigin } });
      }
    }
    const doc = new Y.Doc(guid === undefined ? {} : { guid });
    const provider = new WebsocketProvider(`${origin}/m/${machineId}/room`, name, doc, {
      params,
      disableBc: true,
      WebSocketPolyfill: CookieSocket as unknown as typeof WebSocket,
      shouldReconnect: (event: CloseEvent) => !isRefusal(event.code),
      maxBackoffTime: 1_000,
    } as ConstructorParameters<typeof WebsocketProvider>[3]);
    provider.disconnectBc = () => undefined;
    const room = new Room(provider, doc);
    this.#rooms.add(room);
    return room;
  }

  close(): void {
    for (const room of this.#rooms) room.destroy();
    this.#rooms.clear();
  }
}
