import { ChunkedDOTransport } from "@inhuman.tools/chunked-websocket/server";
import { DurableObject } from "cloudflare:workers";

import { CLOSE_BAD_ROOM, CLOSE_OFFLINE, CLOSE_REPLACED, CLOSE_ROOM_CLOSED, isConnectorCode } from "./close-codes.js";
import {
  encodePresenceRemoval,
  encodeTaggedSubscribe,
  encodeTaggedUnsubscribe,
  PRESENCE_QUERY_TEXT,
  routeBrowserPlane,
  routeDaemonPlane,
  type AnnouncedPresence,
  type PresenceClient,
  type StoredSubscription,
} from "./plane.js";
import { newClientTag, parseRoom, roomKey, tagKey } from "./room.js";
import { noDaemonReply, restoreResponse, rewriteRequest } from "./rpc.js";
import { userStub } from "./stubs.js";
import { encodeServerFrame, PING, PONG } from "./tunnel/protocol.js";
import { TunnelServer } from "./tunnel/server.js";

/** The last browser left: keep the daemon room socket this long in case a tab reloads. */
const DEFAULT_ROOM_GRACE_MS = 30_000;
/** The control socket is gone: keep daemon room sockets this long in case the connector reconnects. */
const DEFAULT_CONTROL_GRACE_MS = 60_000;
/** Do not ask the connector to dial the same room again within this long. */
const OPEN_DEBOUNCE_MS = 10_000;
/** Structured-clone attachments are capped at 2 KiB. */
const ATTACHMENT_BUDGET = 1800;
const MAX_AWARENESS_CLIENTS = 24;
const MAX_SUBSCRIPTIONS = 16;

interface ControlAttachment {
  role: "control";
  sub: string;
  machineId: string;
}
interface DaemonAttachment {
  role: "daemon";
  /** The daemon's own upgrade path and query, as dialed. */
  room: string;
  /** Set when the last browser left. Cleared by the next one. */
  idleSince?: number;
  /** Set when the control socket was lost. Cleared when one returns. */
  lostAt?: number;
}
interface BrowserAttachment {
  role: "browser";
  room: string;
  /** Random per socket; prefixes its JSON-RPC ids and shape subscriptionIds. */
  clientTag: string;
  /** Presence clients this socket announced: [id, latest clock]. */
  aw: [number, number][];
  /** Active shape subscriptions announced by this socket (hibernation-safe). */
  subs: StoredSubscription[];
}
type Attachment = ControlAttachment | DaemonAttachment | BrowserAttachment;

/** Per-room in-memory marker; cleared when the DO hibernates so wake re-syncs open sockets. */
interface Room {
  active: boolean;
}

const offline = (): Response =>
  new Response(
    "<!doctype html><title>Machine offline</title><h1>Machine offline</h1><p>The machine is not connected to the relay.</p>",
    {
      status: 503,
      headers: { "content-type": "text/html; charset=utf-8", "retry-after": "5", "cache-control": "no-store" },
    },
  );

/**
 * One per (sub, machineId). Holds the daemon's control socket (presence and the HTTP tunnel), and
 * per room the daemon's room socket plus any browsers, routing UTF-8 JSON reactivity plane frames
 * (`shape/*`, `presence/*`, `stream/delta`, `ping`/`pong`) and JSON-RPC envelopes. The daemon's
 * SQLite database stays the sole source of truth. Close codes and framing: PROTOCOL.md.
 */
export class MachineDO extends DurableObject<Env> {
  private readonly rooms = new Map<string, Room>();
  private readonly opening = new Map<string, number>();
  private readonly transport = new ChunkedDOTransport((ws, data) => this.onMessage(ws, data));
  private readonly tunnel = new TunnelServer((frame) => {
    const control = this.control();
    if (control === undefined) throw new Error("machine offline");
    this.transport.send(control, frame);
  });

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // The edge answers keepalives; idle sockets never wake us.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
  }

  // ---- HTTP entry ----

  override async fetch(req: Request): Promise<Response> {
    const role = req.headers.get("x-relay-role");
    const sub = req.headers.get("x-relay-sub");
    const machineId = req.headers.get("x-relay-machine");
    if (!sub || !machineId) return new Response("not implemented", { status: 501 });
    const url = new URL(req.url);

    if (role === "daemon") {
      if (url.pathname.endsWith("/control")) return this.acceptControl(req, { role: "control", sub, machineId });
      const room = roomOf(url);
      if (room !== null) return this.acceptRoom(req, "daemon", room);
    }
    if (role === "browser") {
      const room = roomOf(url);
      if (room !== null) return this.acceptRoom(req, "browser", room);
      const tunnelPath = /^\/m\/[^/]+(\/.*)$/.exec(url.pathname)?.[1];
      if (tunnelPath === "/file" || tunnelPath === "/app" || tunnelPath?.startsWith("/app/")) {
        return this.serveTunnel(req, tunnelPath + url.search);
      }
    }
    return new Response("not implemented", { status: 501 });
  }

  // ---- control socket and tunnel ----

  private control(): WebSocket | undefined {
    return this.ctx.getWebSockets("control").find((w) => w.readyState === WebSocket.OPEN);
  }

  private async acceptControl(req: Request, att: ControlAttachment): Promise<Response> {
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    // A reconnecting daemon supersedes its stale socket; calls on the old one are lost.
    const stale = this.ctx.getWebSockets("control");
    if (stale.length > 0) this.tunnel.failAll("machine reconnected");
    for (const old of stale) old.close(CLOSE_REPLACED, "replaced");
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], ["control"]);
    pair[1].serializeAttachment(att);
    // Back in contact: room sockets are no longer on a clock, and rooms with browsers but no daemon get dialed.
    for (const ws of this.ctx.getWebSockets()) {
      const a = attachmentOf(ws);
      if (a?.role === "daemon" && a.lostAt !== undefined) {
        delete a.lostAt;
        ws.serializeAttachment(a);
      }
    }
    for (const ws of this.ctx.getWebSockets()) {
      const a = attachmentOf(ws);
      if (a?.role !== "browser") continue;
      const key = roomKey(a.room);
      if (key !== null && this.daemonSocket(key) === undefined) this.requestOpen(a.room, key);
    }
    await userStub(this.env, att.sub).setOnline(att.machineId, true);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  private async serveTunnel(req: Request, target: string): Promise<Response> {
    if (req.method !== "GET" && req.method !== "HEAD") return new Response("method not allowed", { status: 405 });
    if (this.control() === undefined) return offline();
    return this.tunnel.call(req, target);
  }

  private onControlMessage(data: ArrayBuffer | string): void {
    try {
      if (typeof data === "string") this.tunnel.onText(data);
      else this.tunnel.onBinary(data);
    } catch (error) {
      // eslint-disable-next-line no-console -- relay diagnostics, visible in `wrangler tail`
      console.warn("[relay] bad tunnel frame:", error instanceof Error ? error.message : error);
    }
  }

  private requestOpen(original: string, key: string): void {
    const now = Date.now();
    const last = this.opening.get(key);
    if (last !== undefined && now - last < OPEN_DEBOUNCE_MS) return;
    const control = this.control();
    if (control === undefined) return;
    this.opening.set(key, now);
    this.transport.send(control, encodeServerFrame({ t: "open", room: original }));
  }

  // ---- room sockets ----

  private async acceptRoom(req: Request, role: "daemon" | "browser", rest: string): Promise<Response> {
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const parsed = parseRoom(rest);
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    if (parsed === null) {
      server.accept();
      server.close(CLOSE_BAD_ROOM, "unknown room");
      return new Response(null, { status: 101, webSocket: client });
    }
    const { original, key } = parsed;

    if (role === "browser" && this.control() === undefined) {
      server.accept();
      server.close(CLOSE_OFFLINE, "offline");
      return new Response(null, { status: 101, webSocket: client });
    }

    if (role === "daemon") {
      // A redialing connector supersedes its stale room socket.
      for (const old of this.ctx.getWebSockets(`daemon:${tagKey(key)}`)) old.close(CLOSE_REPLACED, "replaced");
    }
    this.ctx.acceptWebSocket(server, [`${role}:${tagKey(key)}`]);
    this.rooms.set(key, { active: true });
    if (role === "daemon") {
      const browsers = this.browserSockets(key);
      const att: DaemonAttachment = { role, room: original };
      if (browsers.length === 0) att.idleSince = Date.now();
      server.serializeAttachment(att);
      this.opening.delete(key);
      if (browsers.length > 0) {
        this.replayBrowserStateToDaemon(server, browsers);
      }
      if (att.idleSince !== undefined) await this.scheduleAlarm(att.idleSince + this.roomGrace());
    } else {
      server.serializeAttachment({
        role,
        room: original,
        clientTag: newClientTag(),
        aw: [],
        subs: [],
      } satisfies BrowserAttachment);
      const daemon = this.daemonSocket(key);
      if (daemon === undefined) {
        this.requestOpen(original, key);
      } else {
        this.clearIdle(daemon);
        // Ask the daemon for its current presence snapshot so the newly joined browser receives it.
        this.send(daemon, PRESENCE_QUERY_TEXT);
      }
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  private ensureRoom(key: string): void {
    if (this.rooms.has(key)) return;
    this.rooms.set(key, { active: true });
    // Woke from hibernation with live sockets: re-establish active subscriptions and presence with daemon.
    const daemon = this.daemonSocket(key);
    const browsers = this.browserSockets(key);
    if (daemon !== undefined && browsers.length > 0) {
      this.replayBrowserStateToDaemon(daemon, browsers);
    }
  }

  private replayBrowserStateToDaemon(daemon: WebSocket, browsers: readonly WebSocket[]): void {
    for (const browser of browsers) {
      const att = attachmentOf(browser);
      if (att?.role !== "browser") continue;
      for (const sub of att.subs) {
        this.send(daemon, encodeTaggedSubscribe(att.clientTag, sub));
      }
    }
    this.send(daemon, PRESENCE_QUERY_TEXT);
  }

  private dropRoom(key: string): void {
    if (this.daemonSocket(key) !== undefined || this.browserSockets(key).length > 0) return;
    this.rooms.delete(key);
  }

  private send(ws: WebSocket, text: string): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      this.transport.send(ws, text);
    } catch {
      // Closing under us; its close event cleans up.
    }
  }

  private daemonSocket(key: string): WebSocket | undefined {
    return this.ctx.getWebSockets(`daemon:${tagKey(key)}`).find((w) => w.readyState === WebSocket.OPEN);
  }

  private browserSockets(key: string): WebSocket[] {
    return this.ctx.getWebSockets(`browser:${tagKey(key)}`).filter((w) => w.readyState === WebSocket.OPEN);
  }

  private roomSockets(key: string): WebSocket[] {
    const daemon = this.daemonSocket(key);
    return daemon === undefined ? this.browserSockets(key) : [daemon, ...this.browserSockets(key)];
  }

  private clearIdle(daemon: WebSocket): void {
    const att = attachmentOf(daemon);
    if (att?.role !== "daemon" || att.idleSince === undefined) return;
    delete att.idleSince;
    daemon.serializeAttachment(att);
  }

  // ---- messages ----

  override async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
    try {
      this.transport.onRawMessage(ws, message);
    } catch (error) {
      // eslint-disable-next-line no-console -- relay diagnostics, visible in `wrangler tail`
      console.warn("[relay] bad frame:", error instanceof Error ? error.stack : error);
    }
  }

  private onMessage(ws: WebSocket, data: ArrayBuffer | string): void {
    const att = attachmentOf(ws);
    if (att === undefined) return;
    if (att.role === "control") {
      this.onControlMessage(data);
      return;
    }
    const key = roomKey(att.room);
    if (key === null) return;
    this.ensureRoom(key);
    // Room traffic is strictly UTF-8 JSON text; legacy binary frames are dropped.
    if (typeof data !== "string") return;
    if (att.role === "browser") this.browserText(ws, att, key, data);
    else this.daemonText(key, data);
  }

  private persistAttachment(ws: WebSocket, att: BrowserAttachment): void {
    while (att.subs.length > MAX_SUBSCRIPTIONS) att.subs.shift();
    att.aw = att.aw.slice(-MAX_AWARENESS_CLIENTS);
    while ((att.aw.length > 0 || att.subs.length > 0) && JSON.stringify(att).length > ATTACHMENT_BUDGET) {
      if (att.aw.length >= att.subs.length && att.aw.length > 0) att.aw.shift();
      else if (att.subs.length > 0) att.subs.shift();
      else break;
    }
    ws.serializeAttachment(att);
  }

  private trackPresence(ws: WebSocket, att: BrowserAttachment, entries: readonly AnnouncedPresence[]): void {
    if (entries.length === 0) return;
    const clients = new Map<number, number>(att.aw);
    for (const entry of entries) {
      if (entry.removed) clients.delete(entry.id);
      else clients.set(entry.id, entry.clock);
    }
    att.aw = [...clients];
    this.persistAttachment(ws, att);
  }

  private recordSubscription(ws: WebSocket, att: BrowserAttachment, sub: StoredSubscription): void {
    const next = att.subs.filter((existing) => existing.id !== sub.id);
    next.push(sub);
    att.subs = next;
    this.persistAttachment(ws, att);
  }

  private removeSubscription(ws: WebSocket, att: BrowserAttachment, subscriptionId: string): void {
    const next = att.subs.filter((existing) => existing.id !== subscriptionId);
    if (next.length === att.subs.length) return;
    att.subs = next;
    this.persistAttachment(ws, att);
  }

  private browserText(ws: WebSocket, att: BrowserAttachment, key: string, text: string): void {
    const plane = routeBrowserPlane(text, att.clientTag);
    switch (plane.kind) {
      case "drop":
        return;
      case "reply":
        this.send(ws, plane.text);
        return;
      case "subscribe": {
        this.recordSubscription(ws, att, plane.sub);
        const daemon = this.daemonSocket(key);
        if (daemon !== undefined) this.send(daemon, plane.daemonText);
        return;
      }
      case "unsubscribe": {
        this.removeSubscription(ws, att, plane.subscriptionId);
        const daemon = this.daemonSocket(key);
        if (daemon !== undefined) this.send(daemon, plane.daemonText);
        return;
      }
      case "presence-update": {
        this.trackPresence(ws, att, plane.entries);
        for (const other of this.roomSockets(key)) {
          if (other !== ws) this.send(other, plane.text);
        }
        return;
      }
      case "presence-query": {
        const daemon = this.daemonSocket(key);
        if (daemon !== undefined) this.send(daemon, plane.text);
        return;
      }
      case "not-plane":
        break;
    }

    const out = rewriteRequest(text, att.clientTag);
    if (out.kind === "drop") return;
    if (out.kind === "reply") {
      this.send(ws, out.text);
      return;
    }
    const daemon = this.daemonSocket(key);
    if (daemon !== undefined) {
      this.send(daemon, out.text);
      return;
    }
    // No daemon to answer: fail the call now instead of leaving it to hang.
    if (out.callId !== undefined) this.send(ws, noDaemonReply(out.callId));
  }

  private daemonText(key: string, text: string): void {
    const plane = routeDaemonPlane(text);
    if (plane.kind !== "not-plane") {
      if (plane.kind === "drop") return;
      const browsers = this.browserSockets(key);
      if (plane.kind === "broadcast") {
        for (const b of browsers) this.send(b, plane.text);
        return;
      }
      const owner = browsers.find((b) => {
        const a = attachmentOf(b);
        return a?.role === "browser" && a.clientTag === plane.clientTag;
      });
      if (owner !== undefined) this.send(owner, plane.text);
      return;
    }

    const out = restoreResponse(text);
    if (out.kind === "drop") return;
    const browsers = this.browserSockets(key);
    if (out.kind === "broadcast") {
      for (const b of browsers) this.send(b, out.text);
      return;
    }
    const owner = browsers.find((b) => {
      const a = attachmentOf(b);
      return a?.role === "browser" && a.clientTag === out.clientTag;
    });
    if (owner !== undefined) this.send(owner, out.text);
  }

  // ---- closing ----

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    await this.gone(ws, code, reason);
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    await this.gone(ws, 1006, "");
  }

  private async gone(ws: WebSocket, code: number, reason: string): Promise<void> {
    this.transport.detach(ws);
    const att = attachmentOf(ws);
    if (att === undefined) return;
    if (att.role === "control") {
      await this.controlGone(ws, att);
      return;
    }
    const key = roomKey(att.room);
    if (key === null) return;
    if (att.role === "browser") {
      const daemon = this.daemonSocket(key);
      if (daemon !== undefined) {
        for (const sub of att.subs) {
          this.send(daemon, encodeTaggedUnsubscribe(att.clientTag, sub.id));
        }
      }
      if (att.aw.length > 0) {
        const removal = encodePresenceRemoval(att.aw as PresenceClient[]);
        for (const peer of this.roomSockets(key)) {
          if (peer !== ws) this.send(peer, removal);
        }
      }
      if (daemon !== undefined && this.browserSockets(key).every((b) => b === ws)) {
        const d = attachmentOf(daemon);
        if (d?.role === "daemon") {
          d.idleSince = Date.now();
          daemon.serializeAttachment(d);
          await this.scheduleAlarm(d.idleSince + this.roomGrace());
        }
      }
      this.dropRoom(key);
      return;
    }
    // Daemon room socket. A newer one for the same room means a redial, not a loss.
    if (this.ctx.getWebSockets(`daemon:${tagKey(key)}`).some((w) => w !== ws && w.readyState === WebSocket.OPEN))
      return;
    this.opening.delete(key);
    // A connector reports a refused upgrade in its own code; anything else is a plain room loss.
    const browserCode = isConnectorCode(code) ? code : CLOSE_ROOM_CLOSED;
    for (const b of this.browserSockets(key)) b.close(browserCode, (reason || "daemon room closed").slice(0, 120));
    this.dropRoom(key);
  }

  private async controlGone(closing: WebSocket, att: ControlAttachment): Promise<void> {
    // Another live control socket means the daemon already reconnected.
    if (this.ctx.getWebSockets("control").some((w) => w !== closing && w.readyState === WebSocket.OPEN)) return;
    this.tunnel.failAll("machine disconnected");
    // Room sockets belong to the connector and usually die with it; if they do not, the alarm ends them.
    const lostAt = Date.now();
    for (const ws of this.ctx.getWebSockets()) {
      const a = attachmentOf(ws);
      if (a?.role !== "daemon") continue;
      a.lostAt = lostAt;
      ws.serializeAttachment(a);
    }
    await this.scheduleAlarm(lostAt + this.controlGrace());
    await userStub(this.env, att.sub).setOnline(att.machineId, false);
  }

  // ---- alarm: idle rooms and orphaned room sockets ----

  private roomGrace(): number {
    return Number(this.env.ROOM_GRACE_MS ?? DEFAULT_ROOM_GRACE_MS);
  }

  private controlGrace(): number {
    return Number(this.env.CONTROL_GRACE_MS ?? DEFAULT_CONTROL_GRACE_MS);
  }

  private async scheduleAlarm(at: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || at < current) await this.ctx.storage.setAlarm(at);
  }

  override async alarm(): Promise<void> {
    const now = Date.now();
    let next: number | null = null;
    for (const ws of this.ctx.getWebSockets()) {
      const att = attachmentOf(ws);
      if (att?.role !== "daemon" || ws.readyState !== WebSocket.OPEN) continue;
      const key = roomKey(att.room);
      const deadlines: number[] = [];
      if (att.idleSince !== undefined) deadlines.push(att.idleSince + this.roomGrace());
      if (att.lostAt !== undefined) deadlines.push(att.lostAt + this.controlGrace());
      if (deadlines.length === 0) continue;
      const due = Math.min(...deadlines);
      if (due > now) {
        next = next === null ? due : Math.min(next, due);
        continue;
      }
      if (key !== null && att.lostAt !== undefined) {
        for (const b of this.browserSockets(key)) b.close(CLOSE_OFFLINE, "offline");
      }
      ws.close(1000, att.lostAt === undefined ? "idle" : "machine offline");
      if (key !== null) {
        this.rooms.delete(key);
      }
    }
    if (next !== null) await this.ctx.storage.setAlarm(next);
  }
}

function roomOf(url: URL): string | null {
  const m = /^\/(?:m|d)\/[^/]+\/room(\/.*)$/.exec(url.pathname);
  return m === null ? null : m[1]! + url.search;
}

function attachmentOf(ws: WebSocket): Attachment | undefined {
  return (ws.deserializeAttachment() as Attachment | null) ?? undefined;
}
