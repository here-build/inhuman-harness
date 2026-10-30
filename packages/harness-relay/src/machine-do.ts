import { ChunkedDOTransport } from "@inhuman.tools/chunked-websocket/server";
import { DurableObject } from "cloudflare:workers";
import * as Y from "yjs";

import { CLOSE_BAD_ROOM, CLOSE_OFFLINE, CLOSE_REPLACED, CLOSE_ROOM_CLOSED, isConnectorCode } from "./close-codes.js";
import { newClientTag, parseRoom, roomKey, tagKey } from "./room.js";
import { noDaemonReply, restoreResponse, rewriteRequest } from "./rpc.js";
import { userStub } from "./stubs.js";
import { encodeAwarenessRemoval, readAwarenessFrame, type AwarenessClient } from "./sync/awareness.js";
import { MESSAGE_AWARENESS, MESSAGE_QUERY_AWARENESS, MESSAGE_SYNC } from "./sync/constants.js";
import {
  encodeDocUpdate,
  encodeSyncStep1,
  handleSyncFrame,
  peekFrame,
  SYNC_STEP1,
  SYNC_STEP2,
} from "./sync/protocol.js";
import { encodeServerFrame, PING, PONG } from "./tunnel/protocol.js";
import { TunnelServer } from "./tunnel/server.js";

/** The last browser left: keep the daemon room socket and the doc this long in case a tab reloads. */
const DEFAULT_ROOM_GRACE_MS = 30_000;
/** The control socket is gone: keep daemon room sockets this long in case the connector reconnects. */
const DEFAULT_CONTROL_GRACE_MS = 60_000;
/** Do not ask the connector to dial the same room again within this long. */
const OPEN_DEBOUNCE_MS = 10_000;
/** Structured-clone attachments are capped at 2 KiB. */
const ATTACHMENT_BUDGET = 1800;
const MAX_AWARENESS_CLIENTS = 24;

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
  /** Random per socket; prefixes its JSON-RPC ids. */
  clientTag: string;
  /** Awareness clients this socket announced: [id, latest clock]. */
  aw: [number, number][];
}
type Attachment = ControlAttachment | DaemonAttachment | BrowserAttachment;

/** One room: memory only, rebuilt after hibernation. */
interface Room {
  doc: Y.Doc;
  /** The daemon answered our sync step 1 in this lifetime, so the doc holds its state. Browsers wait for it. */
  ready: boolean;
  /** Browser step 1 frames held until `ready`. */
  parked: Map<WebSocket, Uint8Array>;
}

const QUERY_AWARENESS = new Uint8Array([MESSAGE_QUERY_AWARENESS]);

const toBuffer = (u8: Uint8Array): ArrayBuffer =>
  u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength
    ? (u8.buffer as ArrayBuffer)
    : (u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer);

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
 * per room the daemon's room socket plus any browsers, with one in-memory Y.Doc each. Documents never
 * touch storage; the daemon stays the source of truth. Close codes and framing: PROTOCOL.md.
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

    const existed = this.rooms.has(key);
    if (role === "daemon") {
      // A redialing connector supersedes its stale room socket.
      for (const old of this.ctx.getWebSockets(`daemon:${tagKey(key)}`)) old.close(CLOSE_REPLACED, "replaced");
    }
    this.ctx.acceptWebSocket(server, [`${role}:${tagKey(key)}`]);
    if (role === "daemon") {
      const att: DaemonAttachment = { role, room: original };
      if (this.browserSockets(key).length === 0) att.idleSince = Date.now();
      server.serializeAttachment(att);
      this.opening.delete(key);
      const room = this.room(key);
      room.ready = false;
      if (existed) this.sendStep1(server, room);
      if (att.idleSince !== undefined) await this.scheduleAlarm(att.idleSince + this.roomGrace());
    } else {
      server.serializeAttachment({
        role,
        room: original,
        clientTag: newClientTag(),
        aw: [],
      } satisfies BrowserAttachment);
      const room = this.room(key);
      if (existed) this.sendStep1(server, room);
      const daemon = this.daemonSocket(key);
      if (daemon === undefined) {
        this.requestOpen(original, key);
      } else {
        this.clearIdle(daemon);
        // The daemon sent its awareness snapshot to the relay once; ask again so this browser gets it.
        this.send(daemon, QUERY_AWARENESS);
      }
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  private room(key: string): Room {
    let room = this.rooms.get(key);
    if (room === undefined) {
      const created: Room = { doc: new Y.Doc(), ready: false, parked: new Map() };
      room = created;
      this.rooms.set(key, created);
      created.doc.on("update", (update: Uint8Array, origin: unknown) => {
        const frame = encodeDocUpdate(update);
        for (const ws of this.roomSockets(key)) if (ws !== origin) this.send(ws, frame);
      });
      // Fresh doc with sockets already attached means we woke from hibernation: ask everyone for state.
      for (const ws of this.roomSockets(key)) this.sendStep1(ws, created);
    }
    return room;
  }

  private dropRoom(key: string): void {
    if (this.daemonSocket(key) !== undefined || this.browserSockets(key).length > 0) return;
    this.rooms.get(key)?.doc.destroy();
    this.rooms.delete(key);
  }

  private sendStep1(ws: WebSocket, room: Room): void {
    this.send(ws, encodeSyncStep1(room.doc));
  }

  private send(ws: WebSocket, data: Uint8Array | string): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      this.transport.send(ws, typeof data === "string" ? data : toBuffer(data));
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
    const room = this.room(key);
    if (typeof data === "string") {
      if (att.role === "browser") this.browserText(ws, att, key, data);
      else this.daemonText(key, data);
      return;
    }
    this.binary(ws, att, key, room, new Uint8Array(data));
  }

  private binary(
    ws: WebSocket,
    att: DaemonAttachment | BrowserAttachment,
    key: string,
    room: Room,
    frame: Uint8Array,
  ): void {
    let head: { type: number; sync: number };
    try {
      head = peekFrame(frame);
    } catch {
      return;
    }
    const fromBrowser = att.role === "browser";
    switch (head.type) {
      case MESSAGE_SYNC: {
        // The daemon's rooms are server-authoritative: clients write through RPC, and their step 2 / updates are dropped.
        if (fromBrowser && head.sync !== SYNC_STEP1) return;
        // A browser told "synced" by a doc the daemon has not filled yet would render an empty kernel.
        if (fromBrowser && head.sync === SYNC_STEP1 && !room.ready) {
          room.parked.set(ws, frame);
          return;
        }
        let reply: Uint8Array | null = null;
        try {
          reply = handleSyncFrame(frame, room.doc, ws);
        } catch (error) {
          // eslint-disable-next-line no-console -- relay diagnostics, visible in `wrangler tail`
          console.warn("[relay] bad sync frame:", error instanceof Error ? error.message : error);
          return;
        }
        if (reply !== null) this.send(ws, reply);
        if (!fromBrowser && head.sync === SYNC_STEP2 && !room.ready) {
          room.ready = true;
          for (const [parked, step1] of room.parked) {
            if (parked.readyState !== WebSocket.OPEN) continue;
            const answer = handleSyncFrame(step1, room.doc, parked);
            if (answer !== null) this.send(parked, answer);
          }
          room.parked.clear();
        }
        return;
      }
      case MESSAGE_AWARENESS: {
        // Relayed verbatim; applying it here would impose y-websocket semantics on the daemon's seats.
        if (att.role === "browser") this.trackAwareness(ws, att, frame);
        for (const other of this.roomSockets(key)) if (other !== ws) this.send(other, frame);
        return;
      }
      case MESSAGE_QUERY_AWARENESS: {
        // Browser: ask the daemon for its snapshot. Daemon: its 10 s keepalive, which keeps browser watchdogs quiet.
        if (fromBrowser) {
          const daemon = this.daemonSocket(key);
          if (daemon !== undefined) this.send(daemon, frame);
        } else {
          for (const b of this.browserSockets(key)) this.send(b, frame);
        }
        return;
      }
      default:
        return;
    }
  }

  private trackAwareness(ws: WebSocket, att: BrowserAttachment, frame: Uint8Array): void {
    let entries: ReturnType<typeof readAwarenessFrame>;
    try {
      entries = readAwarenessFrame(frame);
    } catch {
      return;
    }
    if (entries.length === 0) return;
    const clients = new Map<number, number>(att.aw);
    for (const e of entries) {
      if (e.removed) clients.delete(e.id);
      else clients.set(e.id, e.clock);
    }
    att.aw = [...clients].slice(-MAX_AWARENESS_CLIENTS);
    while (att.aw.length > 0 && JSON.stringify(att).length > ATTACHMENT_BUDGET) att.aw.shift();
    ws.serializeAttachment(att);
  }

  private browserText(ws: WebSocket, att: BrowserAttachment, key: string, text: string): void {
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
      this.rooms.get(key)?.parked.delete(ws);
      const daemon = this.daemonSocket(key);
      // The daemon's awareness would keep this browser's cursors for good: remove them like y-websocket's server does.
      if (daemon !== undefined && att.aw.length > 0)
        this.send(daemon, encodeAwarenessRemoval(att.aw as AwarenessClient[]));
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
    const room = this.rooms.get(key);
    if (room !== undefined) room.ready = false;
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
        const room = this.rooms.get(key);
        room?.doc.destroy();
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
