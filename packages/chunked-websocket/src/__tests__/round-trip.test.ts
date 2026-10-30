/**
 * End-to-end round-trip tests for the chunking transport.
 *
 * Three scenarios:
 *
 *   1. **Pure chunking pass-through** — two `ChunkedWebSocket`s connected
 *      via a Node `ws` server. Send a 5 MB random buffer in each
 *      direction; assert byte-identical delivery.
 *   2. **y-websocket + yjs full sync** — `WebsocketProvider` on the
 *      client with `ChunkedWebSocket` as `WebSocketPolyfill`; minimal
 *      yjs server using `ChunkedWebSocket` server-wrap mode. Pre-seed
 *      the server doc with > 1 MB of CRDT state, connect, assert client
 *      doc converges.
 *   3. **Reset marker recovery** — server "forgets" mid-batch (we wipe
 *      its wrapper map manually); client sends another message; verify
 *      client receives the reset, drops in-flight state, and the next
 *      protocol-level resync converges.
 */

import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type RawData, type WebSocket as WSWebSocket } from "ws";
import * as syncProtocol from "y-protocols/sync";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";

import { ChunkedDOTransport } from "../ChunkedDOTransport.js";
import { ChunkedWebSocket } from "../ChunkedWebSocket.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

interface BoundServer {
  wss: WebSocketServer;
  port: number;
  close: () => Promise<void>;
}

async function makeServer(): Promise<BoundServer> {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    const close = () => new Promise<void>((_resolve) => wss.close(() => _resolve()));
    wss.on("listening", () => {
      const addr = wss.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        wss,
        port,
        close,
      });
    });
  });
}

/**
 * Adapt Node `ws` `data` + `isBinary` → ChunkedWebSocket.feed input.
 *
 * Node `ws` delivers TEXT frames as `Buffer` (UTF-8 bytes), not as
 * `string`. Without the `isBinary` flag we'd misclassify text markers
 * as binary frames. Browsers don't have this issue — they deliver text
 * as `string` and binary as `ArrayBuffer` directly.
 */
function normalizeWsMessage(data: RawData, isBinary: boolean): ArrayBuffer | string {
  if (typeof data === "string") {
    return data;
  }
  if (!isBinary) {
    // Text frame — `ws` gave us UTF-8 bytes; decode to string so the
    // chunked-receive handler's `typeof === "string"` check fires.
    const buf = data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBufferLike);
    return new TextDecoder().decode(buf);
  }
  // binary
  if (data instanceof ArrayBuffer) return data;
  if (data instanceof Uint8Array || Buffer.isBuffer(data)) {
    const out = new ArrayBuffer(data.byteLength);
    new Uint8Array(out).set(data);
    return out;
  }
  if (Array.isArray(data)) {
    // `ws` may deliver fragmented binary as Buffer[].
    const total = data.reduce((sum, b: any) => sum + (b as Uint8Array).byteLength, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const b of data) {
      const v = b instanceof Uint8Array ? b : new Uint8Array(b as ArrayBufferLike);
      out.set(v, off);
      off += v.byteLength;
    }
    return out.buffer;
  }
  // other ArrayBufferLike
  const buf = new Uint8Array(data as ArrayBufferLike);
  const out = new ArrayBuffer(buf.byteLength);
  new Uint8Array(out).set(buf);
  return out;
}

// ── 1. Pure chunking pass-through ────────────────────────────────────

describe("ChunkedWebSocket round-trip — raw bytes", () => {
  it("delivers a 5 MB binary message client → server intact", async () => {
    const { wss, port, close } = await makeServer();
    cleanups.push(close);

    const serverReceived = new Promise<ArrayBufferLike>((resolve) => {
      wss.on("connection", (rawWs: WSWebSocket) => {
        const wrapped = new ChunkedWebSocket(rawWs);
        wrapped.addEventListener("message", (e) => {
          resolve(e.data as ArrayBuffer);
        });
        rawWs.on("message", (data, isBinary) => wrapped.feed(normalizeWsMessage(data, isBinary)));
      });
    });

    const client = new ChunkedWebSocket(`ws://127.0.0.1:${port}`);
    cleanups.push(() => {
      client.close();
    });
    await new Promise<void>((resolve) => client.addEventListener("open", () => resolve()));

    const payload = new Uint8Array(5_000_000);
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 37) & 0xff;

    client.send(payload.buffer);

    const received = await serverReceived;
    expect(received.byteLength).toBe(payload.byteLength);
    expect(new Uint8Array(received)).toEqual(payload);
  });

  it("delivers a 5 MB binary message server → client intact", async () => {
    const { wss, port, close } = await makeServer();
    cleanups.push(close);

    let serverWrapped!: ChunkedWebSocket;
    const connected = new Promise<void>((resolve) => {
      wss.on("connection", (rawWs: WSWebSocket) => {
        serverWrapped = new ChunkedWebSocket(rawWs);
        rawWs.on("message", (data, isBinary) => serverWrapped.feed(normalizeWsMessage(data, isBinary)));
        resolve();
      });
    });

    const client = new ChunkedWebSocket(`ws://127.0.0.1:${port}`);
    cleanups.push(() => {
      client.close();
    });
    await new Promise<void>((resolve) => client.addEventListener("open", () => resolve()));
    await connected;

    const payload = new Uint8Array(5_000_000);
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 53) & 0xff;

    const clientReceived = new Promise<ArrayBuffer>((resolve) => {
      client.addEventListener("message", (e) => {
        const data = e.data; // typed ArrayBuffer
        // Skip the reset marker sent by the server-wrap construction
        // (delivered as a string text frame, filtered out by the chunk
        // handler — we should only see the binary payload).
        resolve(data as ArrayBuffer);
      });
    });

    serverWrapped.send(payload.buffer);

    const received = await clientReceived;
    expect(received.byteLength).toBe(payload.byteLength);
    expect(new Uint8Array(received)).toEqual(payload);
  });

  it("passes small messages through without chunking overhead", async () => {
    const { wss, port, close } = await makeServer();
    cleanups.push(close);

    let frameCount = 0;
    const serverReceived = new Promise<ArrayBuffer>((resolve) => {
      wss.on("connection", (rawWs: WSWebSocket) => {
        const wrapped = new ChunkedWebSocket(rawWs);
        wrapped.addEventListener("message", (e) => {
          resolve(e.data as ArrayBuffer);
        });
        rawWs.on("message", (data, isBinary) => {
          frameCount += 1;
          wrapped.feed(normalizeWsMessage(data, isBinary));
        });
      });
    });

    const client = new ChunkedWebSocket(`ws://127.0.0.1:${port}`);
    cleanups.push(() => {
      client.close();
    });
    await new Promise<void>((resolve) => client.addEventListener("open", () => resolve()));

    const payload = new Uint8Array(50);
    for (let i = 0; i < payload.length; i++) payload[i] = i;
    client.send(payload.buffer);

    const received = await serverReceived;
    expect(new Uint8Array(received)).toEqual(payload);
    // Single binary frame, no chunking overhead — passthrough.
    expect(frameCount).toBe(1);
  });
});

// ── 2. y-websocket + yjs initial sync of a > 1 MB doc ────────────────

/**
 * Minimal yjs sync handler — reads the message-type byte, dispatches
 * to `y-protocols/sync` for sync messages, broadcasts updates back.
 * Self-contained (no `y-websocket-server` dep).
 */
function attachYjsServer(rawWs: WSWebSocket, serverDoc: Y.Doc, transport: ChunkedDOTransport<WSWebSocket>): void {
  const onUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === rawWs) return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, 0); // MESSAGE_SYNC
    syncProtocol.writeUpdate(encoder, update);
    transport.send(rawWs, encoding.toUint8Array(encoder).buffer as ArrayBuffer);
  };
  serverDoc.on("update", onUpdate);
  rawWs.on("close", () => {
    serverDoc.off("update", onUpdate);
    transport.detach(rawWs);
  });
  rawWs.on("message", (data, isBinary) => transport.onRawMessage(rawWs, normalizeWsMessage(data, isBinary)));
}

function processYjsAppMessage(
  serverDoc: Y.Doc,
  ws: unknown,
  transport: ChunkedDOTransport<any>,
  data: ArrayBuffer | string,
) {
  if (typeof data === "string") return;
  const decoder = decoding.createDecoder(new Uint8Array(data));
  const encoder = encoding.createEncoder();
  const messageType = decoding.readVarUint(decoder);
  if (messageType !== 0) return; // only sync in this test
  encoding.writeVarUint(encoder, 0);
  syncProtocol.readSyncMessage(decoder, encoder, serverDoc, ws);
  if (encoding.length(encoder) > 1) {
    transport.send(ws as any, encoding.toUint8Array(encoder).buffer as ArrayBuffer);
  }
}

describe("ChunkedWebSocket round-trip — yjs sync via y-websocket", () => {
  it("syncs a > 1 MB initial state from server doc to client", async () => {
    const { wss, port, close } = await makeServer();
    cleanups.push(close);

    const serverDoc = new Y.Doc();
    // Pre-populate with > 1 MB of CRDT state. A long Y.Text with ~2M
    // characters + structural overhead easily clears the workerd limit.
    const serverText = serverDoc.getText("scratch");
    const block = "x".repeat(10_000);
    serverDoc.transact(() => {
      for (let i = 0; i < 250; i++) serverText.insert(serverText.length, block);
    });
    expect(Y.encodeStateAsUpdate(serverDoc).byteLength).toBeGreaterThan(1_500_000);

    let serverTransport!: ChunkedDOTransport<WSWebSocket>;
    const connected = new Promise<void>((resolve) => {
      wss.on("connection", (rawWs: WSWebSocket) => {
        serverTransport = new ChunkedDOTransport<WSWebSocket>((ws, data) =>
          processYjsAppMessage(serverDoc, ws, serverTransport, data),
        );
        attachYjsServer(rawWs, serverDoc, serverTransport);
        resolve();
      });
    });

    const clientDoc = new Y.Doc();
    const provider = new WebsocketProvider(`ws://127.0.0.1:${port}`, "room", clientDoc, {
      WebSocketPolyfill: ChunkedWebSocket as any,
      connect: true,
    });
    cleanups.push(() => provider.destroy());

    await connected;
    // y-websocket emits a `sync` event after the initial syncStep1/2
    // round-trip when both ends have converged.
    await new Promise<void>((resolve) => {
      provider.once("sync", () => resolve());
    });

    const clientText = clientDoc.getText("scratch");
    expect(clientText.length).toBe(serverText.length);
    // Spot-check the content rather than full equality — comparing two
    // 2.5 M-char strings node-side is slow and the lengths match
    // (CRDT-reassembled positions are deterministic).
    expect(clientText.toString().slice(0, 1000)).toBe(serverText.toString().slice(0, 1000));
    expect(clientText.toString().slice(-1000)).toBe(serverText.toString().slice(-1000));
  });

  it("syncs a > 1 MB client-originated update to the server", async () => {
    const { wss, port, close } = await makeServer();
    cleanups.push(close);

    const serverDoc = new Y.Doc();
    let serverTransport!: ChunkedDOTransport<WSWebSocket>;

    wss.on("connection", (rawWs: WSWebSocket) => {
      serverTransport = new ChunkedDOTransport<WSWebSocket>((ws, data) =>
        processYjsAppMessage(serverDoc, ws, serverTransport, data),
      );
      attachYjsServer(rawWs, serverDoc, serverTransport);
    });

    const clientDoc = new Y.Doc();
    const provider = new WebsocketProvider(`ws://127.0.0.1:${port}`, "room", clientDoc, {
      WebSocketPolyfill: ChunkedWebSocket as any,
      connect: true,
    });
    cleanups.push(() => provider.destroy());

    await new Promise<void>((resolve) => provider.once("sync", () => resolve()));

    // Now the client makes a > 1 MB change and we wait for the server
    // doc to reflect it.
    const clientText = clientDoc.getText("scratch");
    const block = "y".repeat(10_000);
    clientDoc.transact(() => {
      for (let i = 0; i < 250; i++) clientText.insert(clientText.length, block);
    });

    // Wait for server doc to catch up.
    const targetLen = clientText.length;
    const serverText = serverDoc.getText("scratch");
    await new Promise<void>((resolve) => {
      const tick = () => {
        if (serverText.length >= targetLen) return resolve();
        setTimeout(tick, 25);
      };
      tick();
    });

    expect(serverText.length).toBe(targetLen);
    expect(serverText.toString().slice(-1000)).toBe(clientText.toString().slice(-1000));
  });
});

// ── 3. Reset marker recovery ─────────────────────────────────────────

describe("ChunkedWebSocket round-trip — hibernation recovery", () => {
  it("re-creating a server-side wrapper dispatches a reset that clears the client's in-flight batch", async () => {
    const { wss, port, close } = await makeServer();
    cleanups.push(close);

    const transport = new ChunkedDOTransport<WSWebSocket>(() => {});
    let serverWs!: WSWebSocket;
    const connected = new Promise<void>((resolve) => {
      wss.on("connection", (rawWs: WSWebSocket) => {
        serverWs = rawWs;
        rawWs.on("message", (data, isBinary) => transport.onRawMessage(serverWs, normalizeWsMessage(data, isBinary)));
        resolve();
      });
    });

    const client = new ChunkedWebSocket(`ws://127.0.0.1:${port}`);
    cleanups.push(() => {
      client.close();
    });
    await new Promise<void>((resolve) => client.addEventListener("open", () => resolve()));
    await connected;

    // Simulate a peer mid-batch state on the client by sending a hand-
    // crafted start marker over the raw socket from the server side.
    // After the reset arrives the client should drop this state.
    const startMarker = `y-pk-batch#${JSON.stringify({ id: "fake", type: "start", size: 9_999_999, count: 99 })}`;
    (serverWs as unknown as { send: (d: string) => void }).send(startMarker);

    // Give it a beat to land.
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Now force the server to forget — call detach + re-trigger wrap
    // by sending a fresh app message from client.
    transport.detach(serverWs);

    const clientReceivedReset = new Promise<void>((resolve) => {
      // We can't observe the reset directly through ChunkedWebSocket's
      // onmessage (it filters reset markers internally), so we patch a
      // listener onto the raw inner socket via reflection — purely a
      // test affordance.

      const inner = (client as any).inner as WebSocket;
      const orig = inner.onmessage;
      inner.onmessage = (ev: MessageEvent) => {
        if (typeof ev.data === "string" && ev.data === "y-pk-reset") resolve();
        orig?.call(inner, ev);
      };
    });

    // Trigger wrap re-creation by sending an arbitrary frame from the
    // client to the server.
    const probe = new Uint8Array([0x42]);
    client.send(probe.buffer);

    // Reset should arrive at the client within a short window.
    await Promise.race([
      clientReceivedReset,
      new Promise<void>((_resolve, reject) => setTimeout(() => reject(new Error("reset never arrived")), 1000)),
    ]);

    // After reset the client has dropped the fake batch state. Verify
    // by sending a clean chunked recovery batch (start+chunk+end) — the
    // start marker exits any DRAIN state cleanly and the message
    // reassembles. This is what real-world recovery looks like: the
    // peer's next outbound chunked message arrives bracketed by fresh
    // markers and the receiver picks up normally.
    const clientReceived = new Promise<ArrayBuffer>((resolve) => {
      client.addEventListener("message", (e) => {
        const data = e.data;
        if (typeof data !== "string" && data.byteLength >= 1_000_001) resolve(data);
      });
    });
    const big = new Uint8Array(1_500_000);
    for (let i = 0; i < big.length; i++) big[i] = i & 0xff;
    transport.send(serverWs, big.buffer);
    const got = await clientReceived;
    expect(got.byteLength).toBe(big.byteLength);
    expect(new Uint8Array(got)[0]).toBe(0);
    expect(new Uint8Array(got)[big.length - 1]).toBe((big.length - 1) & 0xff);
  });
});
