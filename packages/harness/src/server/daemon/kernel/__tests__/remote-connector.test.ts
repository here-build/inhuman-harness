import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ChunkedWebSocket } from "@inhuman.tools/chunked-websocket/client";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type RawData, type WebSocket as RawSocket } from "ws";

import { memoryCredentialsStore } from "@/connections/credentials";

import { REMOTE_TOKENS_ID, RemoteAccess } from "../remote-access.js";
import { RemoteConnector } from "../remote-connector.js";
import { serveLocal } from "../remote-http.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function until<T>(fn: () => T | undefined | false, what: string, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = fn();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** `ws` hands text frames over as Buffers; restore the browser shape. */
function normalize(data: RawData, isBinary: boolean): ArrayBuffer | string {
  const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
  if (!isBinary) return buf.toString("utf8");
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

type RelaySocket = {
  readonly kind: "control" | "room";
  readonly path: string;
  readonly auth: string | undefined;
  readonly ws: ChunkedWebSocket;
  readonly raw: RawSocket;
  readonly got: Array<string | ArrayBuffer>;
  close?: { code: number; reason: string };
};

/** A relay that speaks chunked framing and nothing else. */
async function startRelay() {
  const sockets: RelaySocket[] = [];
  const attempts: Array<string | undefined> = [];
  const state = { status: 0 };
  const server = createServer();
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    attempts.push(req.headers.authorization);
    if (state.status !== 0) {
      socket.end(`HTTP/1.1 ${state.status} no\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    wss.handleUpgrade(req, socket, head, (raw) => {
      const path = (req.url ?? "").replace(/^\/d\/[^/]+/, "");
      const ws = new ChunkedWebSocket(raw);
      const entry: RelaySocket = {
        kind: path.startsWith("/control") ? "control" : "room",
        path,
        auth: req.headers.authorization,
        ws,
        raw,
        got: [],
      };
      raw.on("message", (data, isBinary) => ws.feed(normalize(data, isBinary)));
      raw.on("close", (code, reason) => {
        entry.close = { code, reason: reason.toString() };
      });
      ws.addEventListener("message", (event) => entry.got.push(event.data));
      sockets.push(entry);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => {
    for (const client of wss.clients) client.terminate();
    server.close();
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    sockets,
    attempts,
    state,
    controls: () => sockets.filter((s) => s.kind === "control"),
    rooms: () => sockets.filter((s) => s.kind === "room"),
    sendControl(target: RelaySocket, frame: object) {
      target.ws.send(JSON.stringify(frame));
    },
  };
}

type DaemonSocket = {
  readonly url: string;
  readonly ws: RawSocket;
  readonly got: Array<{ data: Buffer; isBinary: boolean }>;
  closed: boolean;
};

/** Stands in for the daemon's unix socket. `/missing` is refused like an unknown session. */
async function startDaemon() {
  const dir = mkdtempSync(join(tmpdir(), "hrc-"));
  const sock = join(dir, "d.sock");
  const sockets: DaemonSocket[] = [];
  const server: Server = createServer();
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if ((req.url ?? "").startsWith("/missing")) {
      socket.write("HTTP/1.1 404 not found\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const entry: DaemonSocket = { url: req.url ?? "", ws, got: [], closed: false };
      ws.on("message", (data, isBinary) => entry.got.push({ data: data as Buffer, isBinary }));
      ws.on("close", () => {
        entry.closed = true;
      });
      sockets.push(entry);
    });
  });
  await new Promise<void>((resolve) => server.listen(sock, resolve));
  cleanups.push(() => {
    for (const client of wss.clients) client.terminate();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { sock, sockets };
}

const FAR = () => new Date(Date.now() + 3_600_000).toISOString();

function access(relayUrl: string, tokens: Record<string, string> | null, fetchImpl?: typeof fetch) {
  const credentials = memoryCredentialsStore(tokens === null ? {} : { [REMOTE_TOKENS_ID]: tokens });
  const remote = new RemoteAccess({
    credentials: { read: credentials.read, write: credentials.write! },
    env: { HARNESS_REMOTE_URL: relayUrl, HARNESS_REMOTE_WORKOS_CLIENT_ID: "client_test" },
    hostname: () => "box",
    ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
  });
  return { remote, credentials };
}

/** A WorkOS whose refresh answers with `tok-<n>` and expires at once, so every connect refreshes. */
function refreshingWorkos(answer?: { status: number; error: string }) {
  let n = 1;
  const impl: typeof fetch = () => {
    if (answer !== undefined) return Promise.resolve(Response.json({ error: answer.error }, { status: answer.status }));
    n += 1;
    return Promise.resolve(
      Response.json({ access_token: `tok-${n}`, refresh_token: `refresh-${n}`, expires_in: 1, user: { id: "u" } }),
    );
  };
  return impl;
}

const FAST = { baseMs: 10, maxMs: 40 };

type Rig = Awaited<ReturnType<typeof rig>>;

async function rig(
  options: {
    tokens?: Record<string, string> | null;
    fetch?: typeof fetch;
    staticDir?: string;
    roots?: string[];
    keepaliveMs?: number;
  } = {},
) {
  const relay = await startRelay();
  const daemon = await startDaemon();
  const { remote, credentials } = access(
    relay.url,
    options.tokens === undefined ? { apiKey: "tok-1", refreshToken: "refresh-1", expiresAt: FAR() } : options.tokens,
    options.fetch,
  );
  const connector = new RemoteConnector({
    access: remote,
    sockPath: daemon.sock,
    http: { staticDir: options.staticDir, fileRoots: () => options.roots ?? [] },
    backoff: FAST,
    random: () => 1,
    ...(options.keepaliveMs === undefined ? {} : { keepaliveMs: options.keepaliveMs }),
  });
  cleanups.push(() => connector.stop());
  return { relay, daemon, remote, credentials, connector };
}

async function control(r: Rig) {
  r.connector.start();
  return until(() => r.relay.controls()[0], "control socket");
}

async function openRoom(r: Rig, ctl: RelaySocket, room: string) {
  r.relay.sendControl(ctl, { t: "open", room });
  const relaySide = await until(() => r.relay.rooms().find((s) => s.path === `/room${room}`), "relay room socket");
  const daemonSide = await until(() => r.daemon.sockets.find((s) => s.url === room), "daemon socket");
  return { relaySide, daemonSide };
}

const bigText = (bytes: number): string => "aé€😀".repeat(Math.ceil(bytes / 10));

describe("connector control socket", () => {
  it("dials with the bearer token and machine name, and reports connected", async () => {
    const r = await rig();
    const ctl = await control(r);
    expect(ctl.auth).toBe("Bearer tok-1");
    expect(ctl.path).toBe(`/control?name=box`);
    await until(() => r.connector.connected, "connected");
    await r.connector.stop();
    expect(r.connector.connected).toBe(false);
    await until(() => r.relay.controls()[0]?.close, "control closed");
  });

  it("pings every socket on the keepalive interval and drops pong", async () => {
    const r = await rig({ keepaliveMs: 30 });
    const ctl = await control(r);
    await until(() => ctl.got.length === 0 && r.relay.controls()[0]?.raw.readyState === 1, "open");
    const { relaySide, daemonSide } = await openRoom(r, ctl, "/session?sessionId=s1");
    await until(() => relaySide.got.includes(" ping"), "room ping");
    const rawPings = new Set<string>();
    ctl.raw.on("message", (d, isBinary) => !isBinary && rawPings.add(d.toString()));
    await until(() => rawPings.has(" ping"), "control ping");
    relaySide.ws.send(" pong");
    await settle(100);
    expect(daemonSide.got).toEqual([]);
  });

  it("serves a request after a reconnect with a fresh token", async () => {
    const r = await rig({
      tokens: { apiKey: "tok-1", refreshToken: "refresh-1", expiresAt: new Date(Date.now() + 1000).toISOString() },
      fetch: refreshingWorkos(),
    });
    const first = await control(r);
    expect(first.auth).toBe("Bearer tok-2");
    first.raw.terminate();
    const second = await until(() => r.relay.controls()[1], "second control");
    expect(second.auth).toBe("Bearer tok-3");
    expect(r.connector.running).toBe(true);
  });
});

describe("login loss", () => {
  it("treats a refresh invalid_grant as logged out", async () => {
    const r = await rig({
      tokens: { apiKey: "tok-1", refreshToken: "refresh-1", expiresAt: new Date(Date.now() - 1000).toISOString() },
      fetch: refreshingWorkos({ status: 400, error: "invalid_grant" }),
    });
    r.connector.start();
    await until(() => !r.connector.running, "connector stop");
    const status = r.remote.status(r.connector.connected);
    expect(status.loggedIn).toBe(false);
    expect(status.lastError).toMatch(/harness login/);
    expect(r.relay.attempts).toEqual([]);
  });

  it("treats a relay 401 after a fresh refresh as logged out", async () => {
    const r = await rig({ fetch: refreshingWorkos() });
    r.relay.state.status = 401;
    r.connector.start();
    await until(() => !r.connector.running, "connector stop");
    const status = r.remote.status();
    expect(status.loggedIn).toBe(false);
    expect(status.lastError).toMatch(/relay rejected/);
    // cached token, its probe, then the refreshed token and its probe
    expect(r.relay.attempts).toContain("Bearer tok-1");
    expect(r.relay.attempts).toContain("Bearer tok-2");
  });

  it("keeps retrying, logged in, while the relay is merely unreachable or forbids", async () => {
    const r = await rig();
    r.relay.state.status = 403;
    r.connector.start();
    await until(() => r.relay.attempts.length >= 4, "retries");
    expect(r.connector.running).toBe(true);
    expect(r.remote.status().loggedIn).toBe(true);
    r.relay.state.status = 0;
    await until(() => r.connector.connected, "connected after the relay recovers");
  });
});

describe("room bridge", () => {
  it("dials on open, ignores a repeat, and bridges binary and text over 1 MiB both ways", async () => {
    const r = await rig();
    const ctl = await control(r);
    const room = "/session?sessionId=s1&path=%2Fwork";
    const { relaySide, daemonSide } = await openRoom(r, ctl, room);
    expect(relaySide.auth).toBe("Bearer tok-1");
    r.relay.sendControl(ctl, { t: "open", room });
    await settle(150);
    expect(r.relay.rooms()).toHaveLength(1);
    expect(r.daemon.sockets).toHaveLength(1);

    const bin = new Uint8Array(1_500_000).map((_, i) => i % 251);
    const text = bigText(1_400_000);
    relaySide.ws.send(bin);
    relaySide.ws.send(text);
    relaySide.ws.send('{"jsonrpc":"2.0","id":"a:1","method":"m"}');
    await until(() => daemonSide.got.length === 3, "daemon frames");
    expect(daemonSide.got[0]?.isBinary).toBe(true);
    expect(new Uint8Array(daemonSide.got[0]!.data)).toEqual(bin);
    expect(daemonSide.got[1]?.isBinary).toBe(false);
    expect(daemonSide.got[1]!.data.toString("utf8") === text).toBe(true);
    expect(daemonSide.got[2]!.data.toString()).toBe('{"jsonrpc":"2.0","id":"a:1","method":"m"}');

    daemonSide.ws.send(bin, { binary: true });
    daemonSide.ws.send(text);
    daemonSide.ws.send('{"jsonrpc":"2.0","id":"a:1","result":1}');
    await until(() => relaySide.got.filter((g) => g !== " ping").length === 3, "relay frames");
    const back = relaySide.got.filter((g) => g !== " ping");
    expect(new Uint8Array(back[0] as ArrayBuffer)).toEqual(bin);
    expect(back[1] === text).toBe(true);
    expect(back[2]).toBe('{"jsonrpc":"2.0","id":"a:1","result":1}');
  });

  it("drops the daemon's query-awareness keepalive but passes the relay's query and other frames", async () => {
    const r = await rig();
    const ctl = await control(r);
    const { relaySide, daemonSide } = await openRoom(r, ctl, "/kernel");
    daemonSide.ws.send(new Uint8Array([3]), { binary: true });
    daemonSide.ws.send(new Uint8Array([1, 2, 9]), { binary: true });
    await until(() => relaySide.got.length === 1, "awareness frame");
    await settle(100);
    expect(new Uint8Array(relaySide.got[0] as ArrayBuffer)).toEqual(new Uint8Array([1, 2, 9]));
    expect(relaySide.got).toHaveLength(1);

    relaySide.ws.send(new Uint8Array([3]));
    await until(() => daemonSide.got.length === 1, "relay query");
    expect(new Uint8Array(daemonSide.got[0]!.data)).toEqual(new Uint8Array([3]));
  });

  it("closes the relay socket 4000 + status when the daemon refuses the upgrade", async () => {
    const r = await rig();
    const ctl = await control(r);
    r.relay.sendControl(ctl, { t: "open", room: "/missing?x=1" });
    const room = await until(() => r.relay.rooms()[0], "relay room");
    const closed = await until(() => room.close, "relay close");
    expect(closed.code).toBe(4404);
    // The refused room is not kept: another open dials again.
    r.relay.sendControl(ctl, { t: "open", room: "/missing?x=1" });
    await until(() => r.relay.rooms().length === 2, "redial after refusal");
  });

  it("closes the daemon side on relay 1000 and waits for the next open", async () => {
    const r = await rig();
    const ctl = await control(r);
    const { relaySide, daemonSide } = await openRoom(r, ctl, "/project?path=%2Fp");
    relaySide.raw.close(1000, "idle");
    await until(() => daemonSide.closed, "daemon side closed");
    await settle(250);
    expect(r.relay.rooms()).toHaveLength(1);
    expect(r.daemon.sockets).toHaveLength(1);
    r.relay.sendControl(ctl, { t: "open", room: "/project?path=%2Fp" });
    await until(() => r.relay.rooms().length === 2 && r.daemon.sockets.length === 2, "redial on open");
  });

  it("closes the daemon side when the relay drops, and redials on the next open", async () => {
    const r = await rig();
    const ctl = await control(r);
    const { relaySide, daemonSide } = await openRoom(r, ctl, "/kernel");
    relaySide.raw.terminate();
    await until(() => daemonSide.closed, "daemon side closed");
    r.relay.sendControl(ctl, { t: "open", room: "/kernel" });
    await until(() => r.daemon.sockets.length === 2, "redial");
  });

  it("closes the relay socket when the daemon closes", async () => {
    const r = await rig();
    const ctl = await control(r);
    const { relaySide, daemonSide } = await openRoom(r, ctl, "/kernel");
    daemonSide.ws.close(1001, "going away");
    const closed = await until(() => relaySide.close, "relay close");
    expect(closed.code).toBe(4504);
  });

  it("keeps rooms across a control reconnect", async () => {
    const r = await rig();
    const ctl = await control(r);
    const { daemonSide } = await openRoom(r, ctl, "/kernel");
    ctl.raw.terminate();
    const next = await until(() => r.relay.controls()[1], "second control");
    await settle(50);
    expect(daemonSide.closed).toBe(false);
    r.relay.sendControl(next, { t: "open", room: "/kernel" });
    await settle(100);
    expect(r.daemon.sockets).toHaveLength(1);
  });
});

describe("tunnel HTTP", () => {
  function fixtures() {
    const dir = mkdtempSync(join(tmpdir(), "hrc-fx-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const staticDir = join(dir, "client");
    const project = join(dir, "project");
    mkdirSync(join(staticDir, "assets"), { recursive: true });
    mkdirSync(project);
    writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>app</title>");
    writeFileSync(join(staticDir, "assets", "app-abc123.js"), "console.log(1)");
    const big = join(project, "big.bin");
    writeFileSync(big, Buffer.from(new Uint8Array(1_200_000).map((_, i) => i % 253)));
    writeFileSync(join(dir, "secret.txt"), "secret");
    symlinkSync(join(dir, "secret.txt"), join(project, "link.txt"));
    return { dir, staticDir, project, big };
  }

  /** Issues a `req` and collects what the relay would. */
  async function call(r: Rig, ctl: RelaySocket, id: number, url: string, method = "GET") {
    const frames: Array<{ t: string; [k: string]: unknown }> = [];
    const chunks: Uint8Array[] = [];
    const seen = ctl.got.length;
    r.relay.sendControl(ctl, { t: "req", id, method, url, headers: [] });
    const done = (): boolean => {
      for (const item of ctl.got.slice(seen)) {
        if (typeof item === "string") {
          if (item === " pong") continue;
          const frame = JSON.parse(item) as { t: string; id?: number };
          if (frame.id === id) frames.push(frame);
        } else {
          const view = new DataView(item);
          if (view.getUint32(0) === id) chunks.push(new Uint8Array(item, 4));
        }
      }
      return frames.some((f) => f.t === "end" || f.t === "err");
    };
    await until(() => {
      frames.length = 0;
      chunks.length = 0;
      return done();
    }, `answer to ${url}`);
    const body = Buffer.concat(chunks);
    return {
      head: frames.find((f) => f.t === "head") as unknown as { status: number; headers: Array<[string, string]> },
      frames,
      chunks,
      body,
    };
  }

  it("serves the static app, SPA fallback and hashed assets", async () => {
    const fx = fixtures();
    const r = await rig({ staticDir: fx.staticDir });
    const ctl = await control(r);

    const index = await call(r, ctl, 1, "/app/index.html?v=2");
    expect(index.head.status).toBe(200);
    expect(Object.fromEntries(index.head.headers)["content-type"]).toBe("text/html; charset=utf-8");
    expect(index.body.toString()).toContain("<title>app</title>");

    const route = await call(r, ctl, 2, "/app/sessions/abc");
    expect(route.head.status).toBe(200);
    expect(route.body.toString()).toContain("<title>app</title>");

    const asset = await call(r, ctl, 3, "/app/assets/app-abc123.js");
    expect(Object.fromEntries(asset.head.headers)["cache-control"]).toContain("immutable");
    expect(Object.fromEntries(asset.head.headers)["content-type"]).toContain("text/javascript");

    expect((await call(r, ctl, 4, "/app/assets/nope.js")).head.status).toBe(404);
    expect((await call(r, ctl, 5, "/app/..%2f..%2fsecret.txt")).head.status).toBe(404);
    expect((await call(r, ctl, 6, "/nowhere")).head.status).toBe(404);
  });

  it("streams /file in chunks of at most 256 KiB and refuses paths outside the roots", async () => {
    const fx = fixtures();
    const r = await rig({ roots: [fx.project] });
    const ctl = await control(r);

    const ok = await call(r, ctl, 7, `/file?path=${encodeURIComponent(fx.big)}`);
    expect(ok.head.status).toBe(200);
    expect(ok.chunks.length).toBeGreaterThan(4);
    expect(Math.max(...ok.chunks.map((c) => c.length))).toBeLessThanOrEqual(256 * 1024);
    expect(ok.body.equals(Buffer.from(new Uint8Array(1_200_000).map((_, i) => i % 253)))).toBe(true);

    for (const [id, path] of [
      [8, join(fx.dir, "secret.txt")],
      [9, join(fx.project, "link.txt")],
      [10, "relative.txt"],
    ] as const) {
      expect((await call(r, ctl, id, `/file?path=${encodeURIComponent(path)}`)).head.status).toBe(404);
    }
  });

  it("answers HEAD without a body", async () => {
    const fx = fixtures();
    const r = await rig({ roots: [fx.project] });
    const ctl = await control(r);
    const head = await call(r, ctl, 11, `/file?path=${encodeURIComponent(fx.big)}`, "HEAD");
    expect(head.head.status).toBe(200);
    expect(head.chunks).toHaveLength(0);
  });

  it("aborts a streaming file on cancel", async () => {
    const fx = fixtures();
    const huge = join(fx.project, "huge.bin");
    writeFileSync(huge, "");
    truncateSync(huge, 512 * 1024 * 1024);
    const r = await rig({ roots: [fx.project] });
    const ctl = await control(r);
    const seen = ctl.got.length;
    r.relay.sendControl(ctl, { t: "req", id: 12, method: "GET", url: `/file?path=${encodeURIComponent(huge)}` });
    await until(() => ctl.got.slice(seen).some((g) => typeof g !== "string"), "first chunk");
    r.relay.sendControl(ctl, { t: "cancel", id: 12 });
    await settle(300);
    const count = ctl.got.length;
    await settle(300);
    expect(ctl.got.length).toBe(count);
    const ends = ctl.got.slice(seen).filter((g) => typeof g === "string" && g.includes('"end"'));
    expect(ends).toHaveLength(0);
  });
});

describe("serveLocal", () => {
  it("answers /app with a reason when no static directory was given", async () => {
    const res = await serveLocal({ fileRoots: () => [] }, "GET", "/app/index.html");
    expect(res.status).toBe(404);
    let text = "";
    for await (const chunk of res.body!) text += Buffer.from(chunk).toString();
    expect(text).toMatch(/static directory/);
  });

  it("refuses methods other than GET and HEAD", async () => {
    expect((await serveLocal({ fileRoots: () => [] }, "POST", "/file")).status).toBe(405);
  });
});
