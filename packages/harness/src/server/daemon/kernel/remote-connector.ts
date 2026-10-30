/**
 * The daemon's side of remote access, a long-lived client of the relay
 * (`harness-relay/PROTOCOL.md`). One control socket carries `open` / `req` /
 * `cancel` from the relay; each room is a pair of sockets, a chunked one to
 * the relay and a raw one to this daemon's own unix socket, bridged without
 * parsing Yjs. Runs while logged in; `start` / `stop` are idempotent.
 */
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

import { fail, step } from "@inhuman.tools/harness-diagnostics";
import { ChunkedWebSocket } from "@inhuman.tools/chunked-websocket/client";
import WebSocket, { type RawData } from "ws";

import type { RemoteAccess } from "./remote-access.js";
import { serveLocal, type LocalHttp } from "./remote-http.js";

export type Backoff = { readonly baseMs: number; readonly maxMs: number };

export type RemoteConnectorOptions = {
  readonly access: RemoteAccess;
  /** The daemon's unix socket (what `ensure()` waits on). */
  readonly sockPath: string;
  readonly http: LocalHttp;
  readonly backoff?: Backoff;
  /** 0..1, for tests. */
  readonly random?: () => number;
  readonly keepaliveMs?: number;
  /** Give up on a control handshake that neither opens nor fails. */
  readonly connectTimeoutMs?: number;
};

const PING = " ping";
const PONG = " pong";
const PING_MS = 25_000;
const NODE_CHUNK_BYTES = 256 * 1024;
/** A control socket that lived this long counts as healthy: the backoff restarts. */
const HEALTHY_MS = 10_000;
const CONNECT_TIMEOUT_MS = 20_000;
const SEND_HIGH_WATER = 4 * 1024 * 1024;
const PROBE_TIMEOUT_MS = 5_000;
const OPEN = 1;
const DEFAULT_BACKOFF: Backoff = { baseMs: 1_000, maxMs: 60_000 };

type ControlFrame =
  | { t: "open"; room: string }
  | { t: "req"; id: number; method: string; url: string; headers?: Array<[string, string]> }
  | { t: "cancel"; id: number };

type Room = {
  readonly relay: ChunkedWebSocket;
  readonly local: WebSocket;
  closed: boolean;
};

/** The daemon's 10 s query-awareness keepalive: a binary frame of exactly the y-websocket type 3. */
function isQueryAwareness(bytes: Uint8Array): boolean {
  return bytes.length === 1 && bytes[0] === 3;
}

function rawBytes(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  return data instanceof ArrayBuffer ? Buffer.from(data) : data;
}

/** Node's WebSocket.close accepts only 1000 and 3000-4999. 4504 is what the relay shows browsers for a daemon-side drop. */
function relayCloseCode(code: number): number {
  return code === 1000 || (code >= 3000 && code <= 4999) ? code : 4504;
}

function shortReason(text: string): string {
  return Buffer.from(text).subarray(0, 120).toString("utf8").replaceAll("�", "");
}

export class RemoteConnector {
  readonly #access: RemoteAccess;
  readonly #sockPath: string;
  readonly #http: LocalHttp;
  readonly #backoff: Backoff;
  readonly #random: () => number;
  readonly #pingMs: number;
  readonly #connectMs: number;
  #running = false;
  /** Bumped by every `start`, so a loop still unwinding after `stop` cannot act for the next one. */
  #generation = 0;
  #loop: Promise<void> | null = null;
  #wake: (() => void) | null = null;
  #control: ChunkedWebSocket | null = null;
  #connected = false;
  readonly #rooms = new Map<string, Room>();
  readonly #calls = new Map<number, AbortController>();

  constructor(options: RemoteConnectorOptions) {
    this.#access = options.access;
    this.#sockPath = options.sockPath;
    this.#http = options.http;
    this.#backoff = options.backoff ?? DEFAULT_BACKOFF;
    this.#random = options.random ?? Math.random;
    this.#pingMs = options.keepaliveMs ?? PING_MS;
    this.#connectMs = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
  }

  /** The control socket is open. */
  get connected(): boolean {
    return this.#connected;
  }

  get running(): boolean {
    return this.#running;
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    step("remote connector start");
    this.#loop = this.#run(++this.#generation).catch((error: unknown) => fail("remote connector", error));
  }

  /** Closes every socket and ends the loop. Resolves once the loop has unwound. */
  async stop(): Promise<void> {
    if (!this.#running) return;
    this.#running = false;
    step("remote connector stop");
    this.#wake?.();
    this.#closeAll();
    await this.#loop;
    this.#loop = null;
  }

  async #run(generation: number): Promise<void> {
    const alive = (): boolean => this.#running && generation === this.#generation;
    let attempt = 0;
    let forced = false;
    while (alive()) {
      let token: string | undefined;
      try {
        token = await this.#access.accessToken(Date.now(), forced);
      } catch (error) {
        fail("remote token refresh", error);
        token = undefined;
        await this.#sleep(this.#delay(attempt++));
        continue;
      }
      if (!alive()) return;
      if (token === undefined) {
        // Logged out (logout, or the grant was revoked and the tokens dropped).
        this.#running = false;
        return;
      }
      const result = await this.#session(token);
      if (!alive()) return;
      this.#closeCalls();
      if (result.openedFor === 0 && (await this.#refused(token)) === 401) {
        if (forced) {
          this.#access.revoke("The relay rejected the remote-access login. Run `inhuman login` again.");
          this.#running = false;
          return;
        }
        // A cached token may have been stale; try once more with a refresh.
        forced = true;
        continue;
      }
      forced = false;
      attempt = result.openedFor >= HEALTHY_MS ? 0 : attempt + 1;
      await this.#sleep(this.#delay(attempt));
    }
  }

  #delay(attempt: number): number {
    const ceiling = Math.min(this.#backoff.maxMs, this.#backoff.baseMs * 2 ** Math.min(attempt, 20));
    return Math.round(ceiling * (0.5 + this.#random() * 0.5));
  }

  #sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const done = (): void => {
        clearTimeout(timer);
        this.#wake = null;
        resolve();
      };
      timer = setTimeout(done, ms);
      this.#wake = done;
    });
  }

  /** Control socket for one token. `openedFor` is how long it stayed open; 0 when it never opened. */
  #session(token: string): Promise<{ openedFor: number }> {
    return new Promise((resolve) => {
      const { machineId, machineName } = this.#access.machine();
      const url = `${this.#wsBase()}/d/${encodeURIComponent(machineId)}/control?name=${encodeURIComponent(machineName)}`;
      let socket: ChunkedWebSocket;
      try {
        socket = new ChunkedWebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
      } catch (error) {
        fail("remote control dial", error);
        resolve({ openedFor: 0 });
        return;
      }
      this.#control = socket;
      let openedAt = 0;
      let pinger: NodeJS.Timeout | undefined;
      let dialTimer: NodeJS.Timeout | undefined;
      socket.addEventListener("open", () => {
        openedAt = Date.now();
        this.#connected = this.#control === socket;
        this.#access.noteError(undefined);
        step("remote control open");
        pinger = setInterval(() => {
          if (socket.readyState === OPEN) socket.send(PING);
        }, this.#pingMs);
        pinger.unref();
      });
      socket.addEventListener("message", (event) => {
        if (typeof event.data !== "string" || event.data === PONG) return;
        this.#onControl(event.data);
      });
      let settled = false;
      const settle = (): void => {
        if (settled) return;
        settled = true;
        clearInterval(pinger);
        clearTimeout(dialTimer);
        if (this.#control === socket) {
          this.#control = null;
          this.#connected = false;
        }
        step("remote control closed");
        resolve({ openedFor: openedAt === 0 ? 0 : Math.max(1, Date.now() - openedAt) });
      };
      socket.addEventListener("close", settle);
      // Backstop for a handshake that neither opens nor fails.
      dialTimer = setTimeout(() => {
        if (openedAt !== 0) return;
        try {
          socket.close();
        } catch {
          /* already closed */
        }
        settle();
      }, this.#connectMs);
      dialTimer.unref();
      // A refused handshake raises `error` and, in Node's WebSocket, no `close`.
      socket.addEventListener("error", () => {
        if (openedAt !== 0) return;
        settle();
      });
    });
  }

  #wsBase(): string {
    return this.#access.relayUrl.replace(/^http/i, "ws");
  }

  /**
   * Node's WebSocket hides the upgrade status, so after a connect that never
   * opened, replay the upgrade by hand to read it. `undefined`: unreachable.
   */
  #refused(token: string): Promise<number | undefined> {
    const { machineId } = this.#access.machine();
    const target = new URL(`${this.#access.relayUrl}/d/${encodeURIComponent(machineId)}/control`);
    const send = target.protocol === "https:" ? httpsRequest : httpRequest;
    return new Promise((resolve) => {
      const req = send(target, {
        headers: {
          Connection: "Upgrade",
          Upgrade: "websocket",
          "Sec-WebSocket-Version": "13",
          "Sec-WebSocket-Key": Buffer.from("harness-probe-k!").toString("base64"),
          Authorization: `Bearer ${token}`,
        },
        timeout: PROBE_TIMEOUT_MS,
      });
      req.once("response", (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.once("upgrade", (_res, socket) => {
        socket.destroy();
        resolve(101);
      });
      req.once("timeout", () => {
        req.destroy();
        resolve(undefined);
      });
      req.once("error", () => resolve(undefined));
      req.end();
    });
  }

  #onControl(raw: string): void {
    let frame: ControlFrame;
    try {
      frame = JSON.parse(raw) as ControlFrame;
    } catch {
      return;
    }
    switch (frame.t) {
      case "open":
        if (typeof frame.room === "string") void this.#dialRoom(frame.room);
        break;
      case "req":
        void this.#serve(frame);
        break;
      case "cancel":
        this.#calls.get(frame.id)?.abort();
        break;
    }
  }

  // --- tunnel HTTP ---------------------------------------------------------

  async #serve(frame: Extract<ControlFrame, { t: "req" }>): Promise<void> {
    const control = this.#control;
    if (control === null) return;
    const { id } = frame;
    const abort = new AbortController();
    this.#calls.set(id, abort);
    const text = (message: object): void => {
      if (control.readyState === OPEN) control.send(JSON.stringify(message));
    };
    try {
      const response = await serveLocal(this.#http, frame.method, frame.url, abort.signal);
      if (abort.signal.aborted) return;
      text({ t: "head", id, status: response.status, statusText: response.statusText, headers: response.headers });
      if (response.body !== undefined) {
        for await (const chunk of response.body) {
          for (let at = 0; at < chunk.length; at += NODE_CHUNK_BYTES) {
            if (abort.signal.aborted || control.readyState !== OPEN) return;
            const part = chunk.subarray(at, at + NODE_CHUNK_BYTES);
            const out = new Uint8Array(4 + part.length);
            new DataView(out.buffer).setUint32(0, id);
            out.set(part, 4);
            control.send(out);
            while (control.bufferedAmount > SEND_HIGH_WATER && !abort.signal.aborted) {
              await new Promise((resolve) => setTimeout(resolve, 5));
            }
          }
        }
      }
      if (!abort.signal.aborted) text({ t: "end", id });
    } catch (error) {
      if (!abort.signal.aborted)
        text({ t: "err", id, message: error instanceof Error ? error.message : String(error) });
    } finally {
      if (this.#calls.get(id) === abort) this.#calls.delete(id);
    }
  }

  #closeCalls(): void {
    for (const abort of this.#calls.values()) abort.abort();
    this.#calls.clear();
  }

  // --- rooms ---------------------------------------------------------------

  async #dialRoom(path: string): Promise<void> {
    if (!path.startsWith("/") || path.startsWith("//") || this.#rooms.has(path)) return;
    let token: string | undefined;
    try {
      token = await this.#access.accessToken();
    } catch (error) {
      fail("remote room token", error);
      return;
    }
    // Re-check: another `open` or a stop may have landed during the refresh.
    if (token === undefined || !this.#running || this.#rooms.has(path)) return;
    const { machineId } = this.#access.machine();
    const relay = new ChunkedWebSocket(`${this.#wsBase()}/d/${encodeURIComponent(machineId)}/room${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const local = new WebSocket(`ws+unix://${this.#sockPath}:${path}`);
    const room: Room = { relay, local, closed: false };
    this.#rooms.set(path, room);
    this.#bridge(path, room);
  }

  #bridge(path: string, room: Room): void {
    const { relay, local } = room;
    const toLocal: Array<string | Buffer> = [];
    const toRelay: Array<string | Uint8Array> = [];
    let relayOpen = false;
    let localOpen = false;
    // A refusal can arrive while the relay socket is still connecting; a close sent then is lost.
    let relayClose: { code: number; reason: string } | null = null;
    let pinger: NodeJS.Timeout | undefined;

    const finish = (): void => {
      if (room.closed) return;
      room.closed = true;
      clearInterval(pinger);
      if (this.#rooms.get(path) === room) this.#rooms.delete(path);
    };
    const closeRelay = (code: number, reason: string): void => {
      if (relay.readyState === OPEN) relay.close(code, shortReason(reason));
      else relayClose = { code, reason };
    };

    relay.addEventListener("open", () => {
      relayOpen = true;
      pinger = setInterval(() => {
        if (relay.readyState === OPEN) relay.send(PING);
      }, this.#pingMs);
      pinger.unref();
      if (relayClose !== null) {
        relay.close(relayClose.code, shortReason(relayClose.reason));
        return;
      }
      for (const frame of toRelay.splice(0)) relay.send(frame);
    });
    relay.addEventListener("message", (event) => {
      const data = event.data;
      if (data === PONG) return;
      const frame = typeof data === "string" ? data : Buffer.from(data);
      if (localOpen) local.send(frame, { binary: typeof data !== "string" });
      else toLocal.push(frame);
    });
    relay.addEventListener("close", (event) => {
      const code = (event as CloseEvent).code;
      finish();
      // 1000 is the relay's "idle" / "machine offline": no redial. Anything else waits for the next `open`.
      if (local.readyState === WebSocket.OPEN || local.readyState === WebSocket.CONNECTING) {
        if (local.readyState === WebSocket.CONNECTING) local.terminate();
        else local.close(code === 1000 ? 1000 : 1001);
      }
    });
    relay.addEventListener("error", () => {
      // A refused or unreachable dial raises `error` and, in Node's WebSocket, no `close`.
      if (relayOpen) return;
      finish();
      local.terminate();
    });

    local.on("open", () => {
      localOpen = true;
      for (const frame of toLocal.splice(0)) local.send(frame, { binary: typeof frame !== "string" });
    });
    local.on("message", (data: RawData, isBinary: boolean) => {
      const bytes = rawBytes(data);
      let frame: string | Uint8Array;
      if (isBinary) {
        if (isQueryAwareness(bytes)) return;
        frame = bytes;
      } else {
        frame = bytes.toString("utf8");
      }
      if (relayOpen && relay.readyState === OPEN) relay.send(frame);
      else toRelay.push(frame);
    });
    local.on("unexpected-response", (_request, response) => {
      response.resume();
      const status = response.statusCode ?? 502;
      step(`remote room refused ${status} ${path}`);
      finish();
      closeRelay(4000 + status, response.statusMessage || "refused");
      local.terminate();
    });
    local.on("error", () => {
      // Refusals arrive as unexpected-response; the rest (ENOENT, ECONNREFUSED) follow with a close.
    });
    local.on("close", (code: number, reason: Buffer) => {
      const refused = room.closed;
      finish();
      if (refused) return;
      closeRelay(relayCloseCode(code), reason.toString("utf8") || "daemon closed");
    });
  }

  #closeAll(): void {
    this.#closeCalls();
    for (const room of this.#rooms.values()) {
      room.closed = true;
      try {
        room.relay.close(1000, "connector stopped");
      } catch {
        /* already closed */
      }
      room.local.terminate();
    }
    this.#rooms.clear();
    this.#control?.close(1000, "connector stopped");
    this.#control = null;
    this.#connected = false;
  }
}
