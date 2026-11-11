/**
 * End-to-end round-trip tests for the chunking transport.
 *
 * Three scenarios:
 *
 *   1. **Pure chunking pass-through** — two `ChunkedWebSocket`s connected
 *      via a Node `ws` server. Send a 5 MB random buffer in each
 *      direction; assert byte-identical delivery.
 *   2. **UTF-8 JSON reactivity plane (`shape/delta` + JSON-RPC)** —
 *      `ChunkedWebSocket` client connected to `ChunkedDOTransport` server
 *      exchanging > 1.5 MB JSON text frames in both directions.
 *   3. **Reset marker recovery** — server "forgets" mid-batch (we wipe
 *      its wrapper map manually); client sends another message; verify
 *      client receives the reset, drops in-flight state, and the next
 *      protocol-level resync converges.
 */

import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type RawData, type WebSocket as WSWebSocket } from "ws";

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
    const total = data.reduce((sum, b) => sum + (b instanceof Uint8Array ? b.byteLength : 0), 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const b of data) {
      const v = b instanceof Uint8Array ? b : new Uint8Array(b);
      out.set(v, off);
      off += v.byteLength;
    }
    return out.buffer;
  }
  // other ArrayBufferLike
  const buf = new Uint8Array(data);
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
          if (typeof e.data !== "string") resolve(e.data);
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
    // Buffer.equals: a deep toEqual over 5 M elements takes seconds and times out under load.
    expect(Buffer.from(received).equals(payload)).toBe(true);
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
        if (typeof e.data !== "string") resolve(e.data);
      });
    });

    serverWrapped.send(payload.buffer);

    const received = await clientReceived;
    expect(received.byteLength).toBe(payload.byteLength);
    // Buffer.equals: a deep toEqual over 5 M elements takes seconds and times out under load.
    expect(Buffer.from(received).equals(payload)).toBe(true);
  });

  it("passes small messages through without chunking overhead", async () => {
    const { wss, port, close } = await makeServer();
    cleanups.push(close);

    let frameCount = 0;
    const serverReceived = new Promise<ArrayBuffer>((resolve) => {
      wss.on("connection", (rawWs: WSWebSocket) => {
        const wrapped = new ChunkedWebSocket(rawWs);
        wrapped.addEventListener("message", (e) => {
          if (typeof e.data !== "string") resolve(e.data);
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
    // Buffer.equals: a deep toEqual over 5 M elements takes seconds and times out under load.
    expect(Buffer.from(received).equals(payload)).toBe(true);
    // Single binary frame, no chunking overhead — passthrough.
    expect(frameCount).toBe(1);
  });
});

// ── 2. UTF-8 JSON reactivity plane (> 1 MB shape/delta & JSON-RPC) ────

describe("ChunkedWebSocket round-trip — UTF-8 JSON reactivity plane", () => {
  it("delivers a > 1.5 MB shape/delta snapshot from ChunkedDOTransport to client intact", async () => {
    const { wss, port, close } = await makeServer();
    cleanups.push(close);

    const largeRowJson = JSON.stringify({
      uuid: "root-1",
      tag: "harness:session:root",
      fields: {
        sessionId: "s1",
        transcript: "x".repeat(1_800_000),
      },
    });
    const snapshotFrame = JSON.stringify({
      kind: "shape/delta",
      subscriptionId: "sub-1",
      offset: 1,
      reset: true,
      upserts: [{ id: "s1\troot-1", isRoot: true, revision: 1, rowJson: largeRowJson }],
      deletes: [],
    });
    expect(Buffer.byteLength(snapshotFrame, "utf8")).toBeGreaterThan(1_800_000);

    let serverTransport!: ChunkedDOTransport<WSWebSocket>;
    wss.on("connection", (rawWs: WSWebSocket) => {
      serverTransport = new ChunkedDOTransport<WSWebSocket>((ws, data) => {
        if (typeof data !== "string") return;
        const parsed = JSON.parse(data) as { kind?: string; subscriptionId?: string };
        if (parsed.kind === "shape/subscribe" && parsed.subscriptionId === "sub-1") {
          serverTransport.send(ws, snapshotFrame);
        }
      });
      rawWs.on("close", () => serverTransport.detach(rawWs));
      rawWs.on("message", (data, isBinary) => serverTransport.onRawMessage(rawWs, normalizeWsMessage(data, isBinary)));
    });

    const client = new ChunkedWebSocket(`ws://127.0.0.1:${port}`);
    cleanups.push(() => client.close());
    await new Promise<void>((resolve) => client.addEventListener("open", () => resolve()));

    const receivedDelta = new Promise<string>((resolve) => {
      client.addEventListener("message", (e) => {
        if (typeof e.data === "string") resolve(e.data);
      });
    });

    client.send(
      JSON.stringify({
        kind: "shape/subscribe",
        subscriptionId: "sub-1",
        lane: "session_nodes",
        params: { sessionId: "s1" },
      }),
    );

    const rawDelta = await receivedDelta;
    expect(rawDelta.length).toBe(snapshotFrame.length);
    const decoded = JSON.parse(rawDelta) as {
      kind: string;
      subscriptionId: string;
      upserts: Array<{ rowJson: string }>;
    };
    expect(decoded.kind).toBe("shape/delta");
    expect(decoded.subscriptionId).toBe("sub-1");
    expect(decoded.upserts[0]?.rowJson.length).toBe(largeRowJson.length);
  });

  it("delivers a > 1.5 MB client-originated JSON-RPC request to ChunkedDOTransport intact", async () => {
    const { wss, port, close } = await makeServer();
    cleanups.push(close);

    let serverTransport!: ChunkedDOTransport<WSWebSocket>;
    const serverGotPromptLen = new Promise<number>((resolve) => {
      wss.on("connection", (rawWs: WSWebSocket) => {
        serverTransport = new ChunkedDOTransport<WSWebSocket>((ws, data) => {
          if (typeof data !== "string") return;
          const req = JSON.parse(data) as { id: number; params: { prompt: string } };
          resolve(req.params.prompt.length);
          serverTransport.send(ws, JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { ok: true } }));
        });
        rawWs.on("close", () => serverTransport.detach(rawWs));
        rawWs.on("message", (data, isBinary) =>
          serverTransport.onRawMessage(rawWs, normalizeWsMessage(data, isBinary)),
        );
      });
    });

    const client = new ChunkedWebSocket(`ws://127.0.0.1:${port}`);
    cleanups.push(() => client.close());
    await new Promise<void>((resolve) => client.addEventListener("open", () => resolve()));

    const replyReceived = new Promise<string>((resolve) => {
      client.addEventListener("message", (e) => {
        if (typeof e.data === "string") resolve(e.data);
      });
    });

    const hugePrompt = "y".repeat(1_800_000);
    client.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "turn",
        params: { prompt: hugePrompt },
      }),
    );

    expect(await serverGotPromptLen).toBe(hugePrompt.length);
    expect(JSON.parse(await replyReceived)).toEqual({ jsonrpc: "2.0", id: 7, result: { ok: true } });
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
    serverWs.send(startMarker);

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
      const inner = Reflect.get(client, "inner") as WebSocket;
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
